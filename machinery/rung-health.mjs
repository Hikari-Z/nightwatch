/** Warn-only health read of a rung's text (the loss-taxonomy rules,
 *  2026-10-10): an empty Corrections section usually means the day wasn't
 *  reread — self-authored folds keep what's beautiful and drop what
 *  indicts — and a missing Said-to-me drops the class that already
 *  survives folds worst. Never blocks a fold; the 2am ritual can't stop
 *  to argue. Returns human sentences, [] when healthy. */
export function rungHealth(text) {
  const warnings = [];
  // A section runs from its ## heading to the next ## heading or the end
  // of the text ((?![\s\S]) — JS has no \Z, and $ under /m is end-of-LINE).
  const section = (name) => {
    const m = text.match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    return m ? m[1].trim() : null;
  };
  const corr = section('Corrections');
  if (corr === null) {
    warnings.push("the rung has no Corrections section — the ledger of what died today is the fold's whole defense against a flattering history");
  } else if (corr.replace(/[-*\s]/g, '').length < 40) {
    warnings.push("the Corrections section is (nearly) empty — if the day was truly clean, say why you believe that; an empty ledger usually means the day wasn't reread");
  }
  if (section('Said to me') === null) {
    warnings.push('no Said-to-me section — verbatim quotes survive folds worst of any class, and the slots only exist if the section does');
  }
  return warnings;
}
