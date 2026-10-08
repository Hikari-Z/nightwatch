// `act` is declared in the app manifest so a capability can grant it by name:
// the page is served from 127.0.0.1:7352 (a remote origin to Tauri), and
// remote origins only reach commands a capability allows explicitly.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["act", "set_hit_rects", "fit_window", "set_on_top"])))
        .expect("failed to run tauri-build");
}
