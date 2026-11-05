// Conservative reference-dollar accounting, not a subscription invoice.
export const RATES = Object.freeze({ inputPerMillion: 0.30, outputPerMillion: 1.20 });
export const PRICE_SOURCE = 'https://docs.cline.bot/getting-started/clinepass';

export function reserveCost(payload, maxTokens) {
  // Count every serialized UTF-8 byte as an input token, with extra framing
  // allowance. Cache reads are deliberately charged at the full input rate.
  const inputUpper = Buffer.byteLength(JSON.stringify(payload), 'utf8') + 8192;
  return (inputUpper * RATES.inputPerMillion + maxTokens * RATES.outputPerMillion) / 1e6;
}

export function usageCost(usage) {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) {
    throw new Error('Missing or invalid actual token usage; stop without retrying');
  }
  if (usage.cost !== undefined && (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0)) {
    throw new Error('Invalid provider cost; stop without retrying');
  }
  const conservativeUsd = (usage.prompt_tokens * RATES.inputPerMillion + usage.completion_tokens * RATES.outputPerMillion) / 1e6;
  return { conservativeUsd, providerReportedUsd: usage.cost ?? null, accountedUsd: Math.max(conservativeUsd, usage.cost ?? 0) };
}

export function mayReserve(ledger, amount) {
  const committed = ledger.calls.reduce((sum, call) => sum + (call.accountedUsd ?? call.reservedUsd), 0);
  return Number.isFinite(amount) && amount > 0 && committed + amount <= ledger.limitUsd;
}
