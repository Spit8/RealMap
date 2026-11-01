/** App versions as published on GitHub (tags vX.Y.Z[-pre]): parsing and ordering, semver rules. */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers ("beta.2" → ["beta", "2"]), empty for a release. */
  pre: string[];
}

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

/** < 0 if a is older than b, 0 if equal, > 0 if newer. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a), vb = parseVersion(b);
  if (!va || !vb) return (va ? 1 : 0) - (vb ? 1 : 0);
  const d = va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
  if (d) return Math.sign(d);
  // A release is newer than its pre-releases; identifiers compare numerically when both are numbers.
  if (!va.pre.length || !vb.pre.length) return Math.sign(vb.pre.length - va.pre.length);
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i], y = vb.pre[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    const c = nx && ny ? +x - +y : nx ? -1 : ny ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (c) return Math.sign(c);
  }
  return Math.sign(va.pre.length - vb.pre.length);
}

export const isNewer = (candidate: string, current: string): boolean => compareVersions(candidate, current) > 0;
