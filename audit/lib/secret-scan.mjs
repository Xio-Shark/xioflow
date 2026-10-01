// Token-like strings in text that is about to be stored, or that a model's tool results carried.
// Used as a tripwire: a hit in a run's transcript means the run's confinement failed and the batch must stop.
const PATTERNS = [
  ['url token parameter', /([?&](?:userToken|token|access_token|api_key|apikey|key|auth|signature)=)([A-Za-z0-9_\-.%]{16,})/gi],
  ['jwt', /()(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/g],
  ['sk- key', /()(sk-[A-Za-z0-9_-]{16,})/g],
  ['bearer', /(Bearer\s+)([A-Za-z0-9_\-.]{20,})/g],
  ['env secret', /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^\s"']{12,})/g],
  ['private key', /()(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{20,}?-----END [A-Z ]*PRIVATE KEY-----)/g],
];

/** Returns the text with every match replaced, and the kinds that matched (never the values). */
export function scrubSecrets(text) {
  const kinds = [];
  let clean = text;
  for (const [label, pattern] of PATTERNS) {
    clean = clean.replace(pattern, (_whole, prefix) => {
      kinds.push(label);
      return `${prefix}<redacted>`;
    });
  }
  return { clean, kinds };
}
