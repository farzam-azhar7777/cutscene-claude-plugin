// High-signal patterns for credentials that must never leave the machine in a
// demo context. Matches are reported by kind and line, never echoed, so the
// check itself cannot print a secret into the terminal or the agent's log.
const PATTERNS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["a Cutscene token", /\bcs_[A-Za-z0-9]{30,}/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/],
  ["an address with a password in it", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  // `password = x` style assignments; prose like "Password: choose one" is
  // allowed, a value with digits or symbols after a colon is not.
  [
    "a password or secret value",
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*=\s*["']?[^\s"'&]{4,}/i,
  ],
  [
    "a password or secret value",
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*:\s*["']?(?=[^\s"']*[^A-Za-z\s"'.,;!?])[^\s"']{6,}/i,
  ],
];

// Returns [{ kind, line }] for every line that looks like it holds a secret.
export function findSecrets(text) {
  const findings = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      for (const [kind, pattern] of PATTERNS) {
        if (pattern.test(line)) {
          findings.push({ kind, line: index + 1 });
          break;
        }
      }
    });
  return findings;
}
