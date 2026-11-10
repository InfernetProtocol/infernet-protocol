/**
 * JSON.parse, then once more after mending what writer models get wrong:
 * a value they dropped (`"vocals":, "duration": 120`, seen live from
 * llama-3.3-70b on Workers AI in 2 of 4 album plans) and trailing commas.
 * Returns the value or null; never throws.
 */
export function parseLooseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    /* mend it below */
  }
  try {
    return JSON.parse(String(s).replace(/:\s*(?=[,}\]])/g, ": null").replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
}
