// Nightwatch, phase B step 1: a native shell around the phase-1 viewer.
//
// The page is still served by gui/server.mjs (one renderer, so the browser
// viewer and the app can't drift). This shell adds what a browser tab can't:
// a frameless transparent window, a menu-bar icon, and starting the server
// when it isn't running. Step 2 renders in the webview from gui/emitter.mjs
// once Fable's port lands; write actions arrive through window.NW_HOST.
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PORT: u16 = 7352;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// WEFT_ROOT overrides; the house's own default otherwise.
fn weft_root() -> PathBuf {
    std::env::var("WEFT_ROOT").map(PathBuf::from).unwrap_or_else(|_| home().join("origin/weft"))
}

// An app launched from Finder gets launchd's bare PATH, so a plain `node`
// fails to spawn (the orphan fold could never start for exactly this reason,
// 10/3–10/5). Look in the usual places, then ask a login shell.
fn find_node() -> Option<PathBuf> {
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    let out = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then(|| PathBuf::from(s))
}

fn server_up() -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(300)).is_ok()
}

// Start gui/server.mjs if nothing answers on the port. It outlives the app on
// purpose: the browser viewer at 7352 keeps working after the app quits.
fn ensure_server() -> Result<(), String> {
    if server_up() {
        return Ok(());
    }
    let node = find_node().ok_or("node not found (looked in /opt/homebrew/bin, /usr/local/bin, and the login shell)")?;
    let gui = repo().join("gui"); // the product's own viewer, beside this app in the repo
    let log = std::fs::OpenOptions::new().create(true).append(true).open(gui.join("viewer.log")).map_err(|e| e.to_string())?;
    Command::new(node)
        .arg(gui.join("server.mjs"))
        .env("NIGHTWATCH_PORT", PORT.to_string())
        .current_dir(&gui)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("couldn't start the viewer server: {e}"))?;
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(10) {
        if server_up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("the viewer server started but never answered on 7352".into())
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            cover(&w);
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ---------------------------------------------------------------- actions
// The page's write buttons arrive here through window.NW_HOST.act (contract
// v0.8). Built one at a time, safest first (Ra, 10/6): hide-window, then
// wake. Anything not listed in HOST_CAN stays read-only in the page.
const HOST_CAN: &[&str] = &["hide-window", "wake", "sleep", "retry-wake", "open-terminal", "hide-terminal", "terminal-state", "wake-all", "sleep-all", "restore-checkpoint", "restart-daemon",
    "save-lane", "save-settings", "toggle-nightly", "remove-lane", "emergency-fold", "fold-all", "run-doctor"];

// The product's own source tree (the repo this app was built from): its gui/
// serves the page and its machinery/ is what Set up points new hubs at.
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
fn repo() -> PathBuf { canon(Path::new(REPO)) }
fn app_machinery() -> PathBuf { repo().join("machinery") }

// ---------------------------------------------------------------- hubs
// A hub is one persona's folder: Weft's at ~/origin/weft, Set up's at
// ~/Nightwatch/<slug>. The app finds them in the machine's registry (Fable's
// machinery writes it; the app only reads). Every action acts in one hub, and
// that hub must be one the app shows: the page can never point a script at an
// arbitrary folder. No registry yet: the one default hub, as before.
struct Hub {
    root: PathBuf,
    config_file: PathBuf,
    cfg: serde_json::Value,
    machinery: PathBuf, // the code it runs (paths.machinery; our legacy hub keeps its own wakecycle/)
    state: PathBuf,     // its receipts, lane registry, armed file (paths.wakecycle)
}

fn registry_file() -> PathBuf {
    std::env::var("NIGHTWATCH_REGISTRY").map(PathBuf::from)
        .unwrap_or_else(|_| home().join("Library/Application Support/Nightwatch/hubs.json"))
}

fn registered_hubs() -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read_to_string(registry_file()) else { return vec![] };
    let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { return vec![] };
    j.get("hubs").and_then(|h| h.as_array()).map(|a| a.iter()
        .filter_map(|h| h.get("path").and_then(|p| p.as_str()))
        .filter(|p| p.starts_with('/')).map(PathBuf::from).collect()).unwrap_or_default()
}

fn all_hub_roots() -> Vec<PathBuf> {
    let r = registered_hubs();
    if r.is_empty() { vec![weft_root()] } else { r }
}

fn canon(p: &Path) -> PathBuf { std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()) }

// A path bound for an AppleScript string and a shell command line.
fn plain_path(p: &Path) -> Result<String, String> {
    let s = p.to_string_lossy().to_string();
    if s.chars().any(|c| matches!(c, '"' | '\\' | '$' | '`' | '\n' | '\r')) { Err(format!("{s} has characters the app won't put in a command.")) } else { Ok(s) }
}

fn rel_to(root: &Path, v: Option<&str>, fallback: &str) -> PathBuf {
    match v { Some(s) if s.starts_with('/') => PathBuf::from(s), Some(s) => root.join(s), None => root.join(fallback) }
}

impl Hub {
    fn open(root: &Path) -> Result<Hub, String> {
        let nw = root.join("nightwatch.config.json");
        let config_file = if nw.is_file() { nw } else { root.join("weft.config.json") };
        let raw = std::fs::read_to_string(&config_file).map_err(|e| format!("can't read {}: {e}", config_file.display()))?;
        let cfg: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("{} doesn't parse: {e}", config_file.display()))?;
        let path = |k: &str| cfg.get("paths").and_then(|p| p.get(k)).and_then(|v| v.as_str()).map(String::from);
        let machinery = rel_to(root, path("machinery").as_deref(), "wakecycle");
        let state = rel_to(root, path("wakecycle").as_deref(), "wakecycle");
        Ok(Hub { root: root.to_path_buf(), config_file, cfg, machinery, state })
    }
    fn name(&self) -> String {
        self.cfg.get("persona").and_then(|p| p.get("name")).and_then(|v| v.as_str()).map(String::from)
            .unwrap_or_else(|| self.root.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())
    }
    fn lanes(&self) -> Vec<String> {
        self.cfg.get("lanes").and_then(|l| l.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default()
    }
    // A lane name ends up inside an AppleScript string, so it must be a lane
    // this hub's config knows, spelled plainly. (A typo must never become a
    // default: the --help fold of 10/5.)
    fn check_lane(&self, lane: Option<&str>) -> Result<String, String> {
        let lane = lane.ok_or("no lane given")?;
        let plain = !lane.is_empty() && lane.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let known = self.cfg.get("lanes").and_then(|l| l.get(lane)).is_some();
        if plain && known { Ok(lane.to_string()) } else { Err(format!("\"{lane}\" isn't one of {}'s lanes", self.name())) }
    }
    // The nightshift's launchd job: Set up's per-hub one, else our legacy one.
    fn daemon_label(&self) -> String {
        std::fs::read_dir(&self.state).ok().into_iter().flatten().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| n.starts_with("house.nightwatch.") && n.ends_with(".plist"))
            .map(|n| n.trim_end_matches(".plist").to_string())
            .unwrap_or_else(|| "com.weft.nightshift".into())
    }
    // Every CLI runs this hub's machinery against this hub's config.
    fn node(&self, script: &str, args: &[&str]) -> Result<String, String> {
        let node = find_node().ok_or("node not found")?;
        let out = Command::new(node).arg(self.machinery.join(script)).args(args)
            .env("WEFT_CONFIG", &self.config_file).current_dir(&self.root)
            .output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
        else { Err(String::from_utf8_lossy(&out.stderr).trim().replace("refused: ", "").to_string()) }
    }
}

// The hub an action names. None: the first one the app shows.
fn hub(sel: Option<&str>) -> Result<Hub, String> { hub_among(sel, all_hub_roots()) }
fn hub_among(sel: Option<&str>, roots: Vec<PathBuf>) -> Result<Hub, String> {
    let root = match sel {
        None => roots.first().cloned().ok_or("Nightwatch has no hub yet.")?,
        Some(s) => {
            let want = canon(Path::new(s));
            roots.into_iter().find(|r| canon(r) == want).ok_or(format!("{s} isn't a hub Nightwatch knows (it isn't in the registry)."))?
        }
    };
    Hub::open(&root)
}

// The receipt the wake would resume, and the session it was folded from.
fn receipt_sessions(h: &Hub, lane: &str) -> Result<Vec<String>, String> {
    let p = h.state.join(format!("next-wake.{lane}.json"));
    let raw = std::fs::read_to_string(&p).map_err(|_| format!("{lane} has no sleep receipt (next-wake.{lane}.json); did it sleep?"))?;
    let j: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("next-wake.{lane}.json doesn't parse: {e}"))?;
    Ok(["sessionId", "from"].iter().filter_map(|k| j.get(*k).and_then(|v| v.as_str()).map(String::from)).collect())
}

// wake.sh has no "already awake" guard (the nightshift checks before it
// launches), so this one does: two live resumes of one transcript would
// interleave a single history.
fn live_resume(ps_out: &str, sessions: &[String]) -> Option<String> {
    sessions.iter().find(|s| ps_out.lines().any(|l| l.contains("claude") && l.contains(&format!("--resume {s}")))).cloned()
}

fn wake(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let sessions = receipt_sessions(h, &lane)?;
    let ps = Command::new("/bin/ps").args(["-axo", "command"]).output().map_err(|e| e.to_string())?;
    if let Some(s) = live_resume(&String::from_utf8_lossy(&ps.stdout), &sessions) {
        return Err(format!("{lane} is already awake (a session is resuming {}).", &s[..8.min(s.len())]));
    }
    // Exactly what the nightshift does at 08:00, so the wake is the same wake:
    // this hub's wake.sh, against this hub's config.
    let script = plain_path(&h.machinery.join("wake.sh"))?;
    let cfg = plain_path(&h.config_file)?;
    let run = |src: String| Command::new("/usr/bin/osascript").args(["-e", &src]).output();
    let out = run(format!("tell application \"Terminal\" to do script \"WEFT_CONFIG=\\\"{cfg}\\\" \\\"{script}\\\" {lane}\"")).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Terminal didn't open: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let _ = run("tell application \"Terminal\" to activate".into());
    Ok(format!("Waking {lane}: a Terminal window is resuming it."))
}

// ---------------------------------------------------------------- click-through
// The window is a transparent rectangle, but the app's silhouette isn't, and
// clear pixels still catch clicks. The page reports where its modules are
// (CSS px, viewport-relative); a watcher makes the window ignore the mouse
// whenever the pointer is over none of them, so clicks reach what's behind.
static HIT: Mutex<Vec<[f64; 4]>> = Mutex::new(Vec::new());

#[tauri::command]
fn set_hit_rects(rects: Vec<[f64; 4]>) {
    log::info!("hit areas: {} modules", rects.len());
    *HIT.lock().unwrap() = rects;
}

// rects are [x, y, w, h] in CSS px; (cx, cy) is the pointer in the same space.
fn over_module(rects: &[[f64; 4]], cx: f64, cy: f64) -> bool {
    rects.iter().any(|r| cx >= r[0] - 2.0 && cx <= r[0] + r[2] + 2.0 && cy >= r[1] - 2.0 && cy <= r[1] + r[3] + 2.0)
}

fn watch_pointer(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let Some(w) = app.get_webview_window("main") else { continue };
            if !w.is_visible().unwrap_or(false) { continue; }
            tick = tick.wrapping_add(1);
            if tick % 50 == 0 { cover(&w); } // ~2s: follow Dock and resolution changes
            let (Ok(cur), Ok(pos), Ok(scale)) = (app.cursor_position(), w.inner_position(), w.scale_factor()) else { continue };
            let rects = HIT.lock().unwrap().clone();
            // The window covers the screen, so until the page has said where its modules are, clicks pass
            // through: a page that fails to load must never make the whole desktop unclickable.
            let ignore = rects.is_empty() || !over_module(&rects, (cur.x - pos.x as f64) / scale, (cur.y - pos.y as f64) / scale);
            if ignoring != Some(ignore) {
                let _ = w.set_ignore_cursor_events(ignore);
                ignoring = Some(ignore);
            }
        }
    });
}

// Sleep rings the lane's bell by hand: the nightshift's own ringBell via its
// --ring CLI (same spool note, same ritual, event source "nightwatch"), so
// the app never keeps a second copy of the ritual.
fn sleep(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    match h.node("nightshift.mjs", &["--ring", &lane]) {
        Ok(_) => Ok(format!("Rang {lane}'s bell. It will write its rung and fold.")),
        Err(e) => Err(e.replace("--ring: ", "")),
    }
}

// The window is a transparent canvas over the display's usable area (below
// the menu bar, above the Dock); the page places the app inside it and
// clicks pass through everywhere but the modules (watch_pointer). Ra, 10/6:
// sizing the window to hug the panels, and growing it for every menu,
// dialog and tooltip, kept cutting things off ("there's prolly a more
// elegant method"). A canvas can't cut a menu off, so nothing has to be
// measured. Re-checked every couple of seconds, so a Dock or resolution
// change is followed.
fn work_area(win: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let m = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten())?;
    let s = m.scale_factor();
    let wa = m.work_area();
    Some((wa.position.x as f64 / s, wa.position.y as f64 / s, wa.size.width as f64 / s, wa.size.height as f64 / s))
}
fn cover(win: &tauri::WebviewWindow) {
    let Some((x, y, w, h)) = work_area(win) else { log::warn!("canvas: no monitor to cover"); return };
    let s = win.scale_factor().unwrap_or(1.0);
    let (at, size) = (win.outer_position().map(|p| p.to_logical::<f64>(s)), win.outer_size().map(|z| z.to_logical::<f64>(s)));
    let same = matches!((&at, &size), (Ok(p), Ok(z)) if (p.x - x).abs() < 1.0 && (p.y - y).abs() < 1.0 && (z.width - w).abs() < 1.0 && (z.height - h).abs() < 1.0);
    if same { return; }
    log::info!("canvas: window {:?} {:?} -> covering the work area", at.as_ref().ok().map(|p| (p.x.round(), p.y.round())), size.as_ref().ok().map(|z| (z.width.round(), z.height.round())));
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    log::info!("canvas: {w:.0}x{h:.0} at ({x:.0},{y:.0})");
}

// Restart (Ra, 10/6: Nightwatch stays running, so updates need a way in).
// Relaunch the .app bundle through LaunchServices (`open`), a second after
// this copy exits, so a freshly installed build is what starts, under the
// app's own identity and permissions. Outside a bundle (dev), Tauri's own
// restart.
fn bundle_of(exe: &std::path::Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf())
}
fn restart_app(app: &AppHandle) {
    let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(bundle_of) else { app.restart() };
    let _ = Command::new("/bin/sh").arg("-c").arg("sleep 1; /usr/bin/open \"$0\"").arg(&bundle)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
    app.exit(0);
}

#[cfg(test)]
mod restart_tests {
    use super::bundle_of;
    #[test]
    fn finds_the_app_bundle_above_the_binary() {
        let p = std::path::Path::new("/Users/x/Applications/Nightwatch.app/Contents/MacOS/app");
        assert_eq!(bundle_of(p).unwrap(), std::path::PathBuf::from("/Users/x/Applications/Nightwatch.app"));
        assert!(bundle_of(std::path::Path::new("/tmp/target/debug/app")).is_none());
    }
}

// Keep on top is the viewer's choice (View menu), off unless they ask.
#[tauri::command]
fn set_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no window")?;
    win.set_always_on_top(on).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- batch 2
// Paths come from the hub's one authority (config.mjs get), never from a
// remembered path: a wrong-but-plausible checkpoint path cost the 10/5 morning.
fn cfg_get(h: &Hub, key: &str) -> Result<String, String> {
    let v = h.node("config.mjs", &["get", key]).map_err(|_| format!("config has no {key}"))?;
    if v.is_empty() { return Err(format!("config has no {key}")); }
    Ok(v)
}

// The lane's live Claude Code process: the newest registry entry for the lane
// whose pid is alive AND is actually claude (a recycled pid isn't the lane).
fn lane_pid(h: &Hub, lane: &str) -> Option<u32> {
    let mut best: Option<(std::time::SystemTime, u32)> = None;
    for e in std::fs::read_dir(&h.state).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("lane.") { continue; }
        let Ok(raw) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if j.get("lane").and_then(|v| v.as_str()) != Some(lane) { continue; }
        let Some(pid) = j.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32) else { continue };
        let cmd = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "command="]).output().ok()?;
        if !String::from_utf8_lossy(&cmd.stdout).contains("claude") { continue; }
        let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.map_or(true, |(bt, _)| t > bt) { best = Some((t, pid)); }
    }
    best.map(|(_, p)| p)
}

// The lane's own Terminal tab, found by its tty (Ra, 10/7: "Bring terminal to
// front" flips to "Hide terminal" while the window is showing). One script,
// three verbs: show (un-minimize, select the tab, raise, activate), hide
// (minimize its window) and state ("front", "open", "hidden" or "missing").
// Every verb checks that Terminal is running first: a state query must never
// launch Terminal just to report that nothing is open.
fn lane_terminal(h: &Hub, lane: Option<&str>, verb: &str) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let pid = lane_pid(h, &lane).ok_or(format!("{lane} has no live session to show."))?;
    let out = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "tty="]).output().map_err(|e| e.to_string())?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tty.is_empty() || tty == "??" { return Err(format!("{lane}'s session has no terminal (pid {pid}).")); }
    let body = match verb {
        "show" => "set miniaturized of w to false\n        set selected of t to true\n        set index of w to 1\n        activate\n        return \"found\"",
        "hide" => "set miniaturized of w to true\n        return \"found\"",
        _ => "if miniaturized of w then return \"hidden\"\n        if frontmost and index of w is 1 then return \"front\"\n        return \"open\"",
    };
    let script = format!(r#"if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/{tty}" then
        {body}
      end if
    end repeat
  end repeat
  return "missing"
end tell"#);
    let out = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match (verb, said.as_str()) {
        ("state", s) => Ok(s.to_string()),
        (_, "found") => Ok(String::new()),
        _ => Err(format!("{lane}'s session isn't in a Terminal window (it may be in another terminal app).")),
    }
}

// Every lane of every hub the app shows, one at a time, each through its own
// guards; the summary names what happened to each, refusals included, never
// a bare "done". With several personas, lanes are named with their persona.
fn for_all(f: fn(&Hub, Option<&str>) -> Result<String, String>, quiet_refusal: &str) -> Result<String, String> {
    let roots = all_hub_roots();
    let several = roots.len() > 1;
    let mut done = Vec::new();
    let mut refused = Vec::new();
    for root in roots {
        let h = match Hub::open(&root) { Ok(h) => h, Err(e) => { refused.push(e); continue; } };
        for lane in h.lanes() {
            let who = if several { format!("{} {lane}", h.name()) } else { lane.clone() };
            match f(&h, Some(&lane)) {
                Ok(_) => done.push(who),
                Err(e) if e.contains(quiet_refusal) || e.contains("no sleep receipt") => {}
                Err(e) => refused.push(format!("{who}: {e}")),
            }
        }
    }
    let mut msg = if done.is_empty() { "Nothing to do.".to_string() } else { done.join(", ") + "." };
    if !refused.is_empty() { msg += &format!(" Not done: {}", refused.join("; ")); }
    if refused.is_empty() { Ok(msg) } else { Err(msg) }
}

// Only when the canonical checkpoint is MISSING; only from strictly
// timestamp-named archives (YYYY-MM-DD-HHMM.md). The archive also holds a
// decoy and a stray copy from 10/5, and one wrong pick repeats that morning.
fn is_archive_name(n: &str) -> bool {
    let b = n.as_bytes();
    n.len() == 18 && n.ends_with(".md") && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 13, 14].iter().all(|&i| b[i].is_ascii_digit())
        && b[4] == b'-' && b[7] == b'-' && b[10] == b'-'
}
fn restore_checkpoint(h: &Hub) -> Result<String, String> {
    let cp = PathBuf::from(cfg_get(h, "paths.checkpoint")?);
    if cp.exists() { return Err(format!("The checkpoint is already there ({}); nothing was replaced.", cp.display())); }
    let dir = PathBuf::from(cfg_get(h, "paths.ladder")?).join("checkpoints");
    let newest = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten()
        .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_archive_name(n)).max()
        .ok_or("No timestamped checkpoint archive to restore from.")?;
    std::fs::copy(dir.join(&newest), &cp).map_err(|e| e.to_string())?;
    Ok(format!("Restored the checkpoint from {newest}."))
}

fn restart_daemon(h: &Hub) -> Result<String, String> {
    let uid = String::from_utf8_lossy(&Command::new("/usr/bin/id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
    let out = Command::new("/bin/launchctl").args(["kickstart", "-k", &format!("gui/{uid}/{}", h.daemon_label())])
        .output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok("Restarted the nightshift. Its heartbeat shows within the minute.".into()) }
    else { Err(format!("launchctl refused: {}", String::from_utf8_lossy(&out.stderr).trim())) }
}

// ---------------------------------------------------------------- batch 3
// Settings writes go through the hub's own CLIs (Fable's): config.mjs
// set/unset (atomic, schema- and consistency-checked before any byte lands)
// and nightshift.mjs --arm/--disarm (comma-joined, unknown lanes refused).
// The app never writes those files itself; it validates first so a bad
// field fails here with a plain sentence instead of as a CLI refusal.
fn cfg_set(h: &Hub, key: &str, v: &serde_json::Value) -> Result<String, String> { h.node("config.mjs", &["set", key, &v.to_string()]) }
fn cfg_unset(h: &Hub, key: &str) -> Result<String, String> { h.node("config.mjs", &["unset", key]) }
fn arm(h: &Hub, lane: &str, on: bool) -> Result<String, String> { h.node("nightshift.mjs", &[if on { "--arm" } else { "--disarm" }, lane]) }

fn hhmm(v: Option<&serde_json::Value>, what: &str) -> Result<String, String> {
    let s = v.and_then(|x| x.as_str()).unwrap_or("");
    let b = s.as_bytes();
    let ok = s.len() == 5 && b[2] == b':' && b[..2].iter().chain(&b[3..]).all(|c| c.is_ascii_digit())
        && s[..2].parse::<u32>().map_or(false, |h| h < 24) && s[3..].parse::<u32>().map_or(false, |m| m < 60);
    if ok { Ok(s.to_string()) } else { Err(format!("{what} must be a time like 02:00 (got \"{s}\").")) }
}
fn target_tokens(v: Option<&serde_json::Value>) -> Result<u64, String> {
    let k = v.and_then(|x| x.as_f64()).ok_or("The fold target must be a number.")?;
    if !(10.0..=2000.0).contains(&k) || k.fract() != 0.0 { return Err(format!("The fold target must be a whole number of k between 10 and 2000 (got {k}).")); }
    Ok(k as u64 * 1000)
}

// One lane's settings panel: fold target, global-or-own schedule, armed.
fn save_lane(h: &Hub, lane: Option<&str>, d: &serde_json::Value) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let target = target_tokens(d.get("targetK"))?;
    let inherit = d.get("inherit").and_then(|x| x.as_bool()).unwrap_or(true);
    let own = if inherit { None } else { Some((hhmm(d.get("sleep"), "Sleep")?, hhmm(d.get("wake"), "Wake")?)) };
    cfg_set(h, &format!("lanes.{lane}.targetTokens"), &serde_json::json!(target))?;
    match own {
        None => { cfg_unset(h, &format!("lanes.{lane}.schedule"))?; }
        Some((sl, wk)) => { cfg_set(h, &format!("lanes.{lane}.schedule"), &serde_json::json!({"sleep": sl, "wake": wk}))?; }
    }
    if let Some(on) = d.get("armed").and_then(|x| x.as_bool()) { arm(h, &lane, on)?; }
    Ok(format!("Saved {lane}. The nightshift picks it up on its next check."))
}

// A hub's schedule panel: its schedule, then each of its lanes' rows.
fn save_settings(h: &Hub, d: &serde_json::Value) -> Result<String, String> {
    let sleep = hhmm(d.get("sleep"), "Sleep")?;
    let wake = hhmm(d.get("wake"), "Wake")?;
    let rows = d.get("lanes").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut checked = Vec::new();
    for r in &rows {
        let lane = h.check_lane(r.get("id").and_then(|x| x.as_str()))?;
        checked.push((lane, target_tokens(r.get("targetK"))?, r.get("armed").and_then(|x| x.as_bool())));
    }
    // No restart needed: the nightshift hot-reloads its config on mtime
    // (landed with --fold-now, bench scenario 15: a mid-evening schedule move
    // is honoured by the bell).
    cfg_set(h, "schedule.sleep", &serde_json::json!(sleep))?;
    cfg_set(h, "schedule.wake", &serde_json::json!(wake))?;
    for (lane, target, armed) in checked {
        cfg_set(h, &format!("lanes.{lane}.targetTokens"), &serde_json::json!(target))?;
        if let Some(on) = armed { arm(h, &lane, on)?; }
    }
    Ok(format!("Saved. The nightshift uses {sleep} → {wake} from its next check."))
}

// The deck's Nightly toggle: every lane of every hub armed, or none.
fn toggle_nightly(d: &serde_json::Value) -> Result<String, String> {
    let on = d.get("on").and_then(|x| x.as_bool()).ok_or("toggle-nightly needs on: true|false")?;
    for root in all_hub_roots() {
        let h = Hub::open(&root)?;
        for lane in h.lanes() { arm(&h, &lane, on)?; }
    }
    Ok(if on { "Nightly cycle on: every lane will be belled and woken.".into() } else { "Nightly cycle off: no lane will be belled or woken until you turn it back on.".into() })
}

// Stop managing a lane: disarm, then drop it from the config. Its
// transcripts, ladder and receipts stay on disk (the button's own promise).
fn remove_lane(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    arm(h, &lane, false)?;
    cfg_unset(h, &format!("lanes.{lane}"))?;
    // A lane-list change is structural: the nightshift reads it at boot.
    restart_daemon(h).map_err(|e| format!("Removed {lane}, but the nightshift didn't restart to drop it: {e}"))?;
    Ok(format!("Removed {lane} from Nightwatch. Its transcripts, ladder and receipts are still on disk."))
}

// Fold now (Ra's ruling): ring the real bell; the nightshift owns a 10-minute
// deadline, forces the fold if the lane hasn't folded by then, and either
// way closes the window and wakes a fresh one at once. The daemon's state
// file holds the request, so closing the app doesn't drop it.
fn emergency_fold(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    h.node("nightshift.mjs", &["--fold-now", &lane])
        .map(|_| format!("Rang {lane}'s bell. If it hasn't folded in 10 minutes it's folded for it; then a fresh window opens."))
        .map_err(|e| e.replace("--fold-now: ", ""))
}

// The nightshift's own dry run: what it would do right now, touching nothing.
fn run_doctor(h: &Hub) -> Result<String, String> {
    h.node("nightshift.mjs", &["--preflight"])
}

#[cfg(test)]
mod creation_tests {
    use super::*;
    #[test]
    fn creation_is_offered_only_once_the_cli_exists() {
        let dir = std::env::temp_dir().join(format!("nw-creation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!host_can(&dir).contains(&"plan"));
        std::fs::write(dir.join(NIGHTWATCH_CLI), "").unwrap();
        let can = host_can(&dir);
        for a in CREATION { assert!(can.contains(a), "{a}"); }
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn an_empty_spec_never_reaches_the_cli() {
        let h = Hub { root: "/nowhere".into(), config_file: "/nowhere/x.json".into(), cfg: serde_json::Value::Null, machinery: "/nowhere".into(), state: "/nowhere".into() };
        assert!(with_spec(&h, "apply", &serde_json::Value::Null).is_err());
        assert!(inspect_import(&h, &serde_json::json!({ "from": "  " })).is_err());
    }
}

#[cfg(test)]
mod batch3_tests {
    use super::*;
    #[test]
    fn times_and_targets_are_validated() {
        assert_eq!(hhmm(Some(&serde_json::json!("02:00")), "Sleep").unwrap(), "02:00");
        for bad in ["2:00", "24:00", "12:60", "ab:cd", "", "02:00 "] { assert!(hhmm(Some(&serde_json::json!(bad)), "Sleep").is_err(), "{bad}"); }
        assert_eq!(target_tokens(Some(&serde_json::json!(250))).unwrap(), 250_000);
        for bad in [serde_json::json!(5), serde_json::json!(2500), serde_json::json!(250.5), serde_json::json!("250")] { assert!(target_tokens(Some(&bad)).is_err()); }
    }
}

#[cfg(test)]
mod hub_tests {
    use super::*;
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nw-hub-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn a_hub_reads_its_own_config_machinery_and_state() {
        let new = scratch("new");
        std::fs::write(new.join("nightwatch.config.json"), r#"{"persona":{"name":"Lark"},"lanes":{"main":{}},"paths":{"machinery":"/app/machinery"}}"#).unwrap();
        std::fs::create_dir_all(new.join("wakecycle")).unwrap();
        std::fs::write(new.join("wakecycle/house.nightwatch.lark.plist"), "").unwrap();
        let h = Hub::open(&new).unwrap();
        assert_eq!(h.machinery, PathBuf::from("/app/machinery"));
        assert_eq!(h.state, new.join("wakecycle"));
        assert_eq!(h.name(), "Lark");
        assert_eq!(h.daemon_label(), "house.nightwatch.lark");
        assert!(h.check_lane(Some("main")).is_ok());
        assert!(h.check_lane(Some("fable")).is_err());
        // our legacy hub: weft.config.json, its own wakecycle/ for both, the old job
        let old = scratch("old");
        std::fs::write(old.join("weft.config.json"), r#"{"lanes":{"fable":{}}}"#).unwrap();
        let h = Hub::open(&old).unwrap();
        assert_eq!((h.machinery.clone(), h.state.clone()), (old.join("wakecycle"), old.join("wakecycle")));
        assert_eq!(h.daemon_label(), "com.weft.nightshift");
    }
    #[test]
    fn only_a_registered_hub_can_be_named() {
        let a = scratch("reg-a");
        std::fs::write(a.join("nightwatch.config.json"), r#"{"lanes":{"main":{}}}"#).unwrap();
        let stranger = scratch("stranger");
        std::fs::write(stranger.join("nightwatch.config.json"), r#"{"lanes":{"main":{}}}"#).unwrap();
        let roots = vec![a.clone()];
        assert_eq!(canon(&hub_among(Some(&a.to_string_lossy()), roots.clone()).unwrap().root), canon(&a));
        assert!(hub_among(Some(&stranger.to_string_lossy()), roots.clone()).is_err());
        assert_eq!(canon(&hub_among(None, roots).unwrap().root), canon(&a)); // no hub named: the first
    }
    #[test]
    fn paths_bound_for_a_command_line_are_plain() {
        assert!(plain_path(Path::new("/Users/x/Nightwatch/lark/nightwatch.config.json")).is_ok());
        for bad in ["/a\"b", "/a$b", "/a`b", "/a\\b"] { assert!(plain_path(Path::new(bad)).is_err(), "{bad}"); }
    }
}

// ---------------------------------------------------------------- lane creation
// Set up / Add agent / Import (10/6). The page builds one spec; the house's
// own CLI (Fable's machinery/nightwatch.mjs) dry-runs it (plan) and builds it
// (apply), so the preview the person confirms is exactly what gets done. The
// app only passes things through: the CLI validates and owns every write.
// A lane-add runs in the persona it was opened from (its hub's config); Set
// up makes a new hub, named in the spec, with the app's own machinery.
const CREATION: &[&str] = &["plan", "apply", "inspect-import", "list-unclaimed"];
const NIGHTWATCH_CLI: &str = "nightwatch.mjs";

// Offered only once the CLI exists, so until then Set up and Preview stay
// read-only instead of failing on press.
fn creation_ready(machinery: &std::path::Path) -> bool { machinery.join(NIGHTWATCH_CLI).is_file() }

fn with_spec(h: &Hub, op: &str, d: &serde_json::Value) -> Result<String, String> {
    if !d.is_object() { return Err("The app sent an empty spec; nothing was done.".into()); }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("nightwatch-spec-{}-{nanos}.json", std::process::id()));
    std::fs::write(&path, d.to_string()).map_err(|e| format!("couldn't write the spec: {e}"))?;
    let out = h.node(NIGHTWATCH_CLI, &[op, &path.to_string_lossy()]);
    let _ = std::fs::remove_file(&path);
    out
}

fn inspect_import(h: &Hub, d: &serde_json::Value) -> Result<String, String> {
    let from = d.get("from").and_then(|x| x.as_str()).filter(|x| !x.trim().is_empty()).ok_or("Type the folder to import.")?;
    h.node(NIGHTWATCH_CLI, &["inspect-import", from])
}

// The hub that runs a creation step: Set up (op "init") runs the app's own
// machinery; everything else runs in the hub the action names.
fn creation_hub(sel: Option<&str>, d: &serde_json::Value) -> Result<Hub, String> {
    let mut h = hub(sel)?;
    if d.get("op").and_then(|v| v.as_str()) == Some("init") { h.machinery = app_machinery(); }
    Ok(h)
}

#[tauri::command]
fn act(app: AppHandle, action: String, lane: Option<String>, hub: Option<String>, data: Option<serde_json::Value>) -> Result<String, String> {
    let d = data.unwrap_or(serde_json::Value::Null);
    log::info!("act {action} lane={lane:?} hub={hub:?}");
    let sel = hub.as_deref();
    let h = || self::hub(sel);
    let lane = lane.as_deref();
    match action.as_str() {
        // The page pings once at load: proof the bridge is permitted.
        "ping" => Ok("pong".into()),
        "hide-window" => {
            if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
            Ok(String::new())
        }
        "wake" | "retry-wake" => wake(&h()?, lane),
        "sleep" => sleep(&h()?, lane),
        "open-terminal" => lane_terminal(&h()?, lane, "show"),
        "hide-terminal" => lane_terminal(&h()?, lane, "hide"),
        "terminal-state" => lane_terminal(&h()?, lane, "state"),
        "wake-all" => for_all(wake, "already awake").map(|m| format!("Woke: {m}")),
        "sleep-all" => for_all(sleep, "not awake").map(|m| format!("Rang the bell for: {m}")),
        "restore-checkpoint" => restore_checkpoint(&h()?),
        "restart-daemon" => restart_daemon(&h()?),
        "save-lane" => save_lane(&h()?, lane, &d),
        "save-settings" => save_settings(&h()?, &d),
        "toggle-nightly" => toggle_nightly(&d),
        "remove-lane" => remove_lane(&h()?, lane),
        "emergency-fold" => emergency_fold(&h()?, lane),
        "fold-all" => for_all(emergency_fold, "not awake").map(|m| format!("Fold requested for: {m}")),
        "run-doctor" => run_doctor(&h()?),
        "plan" => with_spec(&creation_hub(sel, &d)?, "plan", &d),
        "apply" => with_spec(&creation_hub(sel, &d)?, "apply", &d),
        "inspect-import" => inspect_import(&h()?, &d),
        "list-unclaimed" => h()?.node(NIGHTWATCH_CLI, &["list-unclaimed"]),
        other => Err(format!("{other} isn't wired in the app yet")),
    }
}

// Tells the page it's inside the app (runtime.js then leaves the window
// transparent) and gives it the host bridge. can() names what's wired, so
// every other write button keeps its read-only state.
fn init_script() -> String {
    format!(r#"window.NW_SHELL = 'tauri';
window.NW_HOST = {{
  can: (a) => {can}.includes(a),
  act: (action, o = {{}}) => window.__TAURI_INTERNALS__.invoke('act', {{ action, lane: o.lane ?? null, hub: o.hub ?? null, data: o.data ?? null }}),
  hitRects: (rects) => window.__TAURI_INTERNALS__.invoke('set_hit_rects', {{ rects }}),
  onTop: (on) => window.__TAURI_INTERNALS__.invoke('set_on_top', {{ on }}),
}};
addEventListener('DOMContentLoaded', () => window.NW_HOST.act('ping').catch((e) => console.error('nightwatch bridge:', e)));"#, can = serde_json::to_string(&host_can(&app_machinery())).unwrap())
}

fn host_can(machinery: &std::path::Path) -> Vec<&'static str> {
    let mut v = HOST_CAN.to_vec();
    if creation_ready(machinery) { v.extend_from_slice(CREATION); }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lanes_must_be_known_and_plain() {
        let h = Hub { root: "/h".into(), config_file: "/h/c.json".into(), cfg: serde_json::json!({"lanes": {"fable": {}, "opus": {}}}), machinery: "/h".into(), state: "/h".into() };
        assert_eq!(h.check_lane(Some("opus")).unwrap(), "opus");
        assert!(h.check_lane(Some("scout")).is_err());
        assert!(h.check_lane(Some("opus\" & quit")).is_err());
        assert!(h.check_lane(Some("")).is_err());
        assert!(h.check_lane(None).is_err());
    }
    #[test]
    fn only_timestamped_archives_restore() {
        assert!(is_archive_name("2026-10-06-0204.md"));
        assert!(!is_archive_name("decoy-wakecycle-copy-2026-10-05.md"));
        assert!(!is_archive_name("stray-root-copy-removed-2026-10-05.md"));
        assert!(!is_archive_name("2026-10-06-0204.md.bak"));
        assert!(!is_archive_name("2026-10-06-02a4.md"));
    }
    #[test]
    fn pointer_over_modules_only() {
        let r = vec![[0.0, 0.0, 100.0, 40.0], [0.0, 40.0, 60.0, 50.0]]; // an L: head, then a narrower card
        assert!(over_module(&r, 50.0, 20.0));
        assert!(over_module(&r, 30.0, 70.0));
        assert!(!over_module(&r, 90.0, 70.0)); // the empty corner
        assert!(!over_module(&[], 10.0, 10.0));
    }
    #[test]
    fn refuses_a_lane_that_is_already_resumed() {
        let ps = "COMMAND\nclaude --resume 3e865d2d-x --fork-session\n/bin/zsh\n";
        let s = vec!["b438479a-y".to_string(), "3e865d2d-x".to_string()];
        assert_eq!(live_resume(ps, &s).as_deref(), Some("3e865d2d-x"));
        assert_eq!(live_resume("claude --resume other\n", &s), None);
        // a grep or an editor naming the sid isn't a live session
        assert_eq!(live_resume("grep --resume 3e865d2d-x\n", &s), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Logged in every build (~/Library/Logs/house.weft.nightwatch/): the installed app is a release
            // build, and a problem only the real window shows needs its own receipts (10/6, the menu cutoff).
            app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            log::info!("nightwatch starting; repo {}, hubs {:?}", repo().display(), all_hub_roots());
            // A menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let url = match ensure_server() {
                Ok(()) => format!("http://127.0.0.1:{PORT}/"),
                Err(e) => {
                    log::error!("{e}");
                    format!("data:text/html,<body style='font:14px system-ui;padding:24px;background:%23111;color:%23ddd'>Nightwatch couldn't start its viewer: {}</body>", e.replace('#', "%23"))
                }
            };
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Nightwatch")
                .inner_size(1100.0, 760.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(false) // the page applies the viewer's stored choice
                .initialization_script(&init_script())
                .build()?;
            cover(&win);

            let show = MenuItem::with_id(app, "toggle", "Show or hide Nightwatch", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart Nightwatch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Nightwatch", true, None::<&str>)?;
            TrayIconBuilder::with_id("nightwatch")
                // A template image: macOS recolours it for light and dark menu bars.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Nightwatch")
                .menu(&Menu::with_items(app, &[&show, &restart, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "toggle" => toggle(app),
                    "restart" => restart_app(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;
            watch_pointer(app.handle().clone());
            Ok(())
        })
        // Closing the window hides it; the menu-bar icon brings it back.
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![act, set_hit_rects, set_on_top])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
