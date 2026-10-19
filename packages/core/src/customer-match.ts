export interface CustomerCandidate {
  id: string;
  name: string;
  preferredName: string | null;
}

export type CustomerResolution =
  | { kind: 'resolved'; customer: CustomerCandidate; basis: 'selected' | 'exact_name' | 'surname' }
  | { kind: 'ambiguous'; matches: CustomerCandidate[] }
  | { kind: 'none' };

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr']);

function normalise(value: string): string {
  return value
    .toLocaleLowerCase('en-NZ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalise(value)
    .split(' ')
    .filter((token) => token.length > 0 && !HONORIFICS.has(token));
}

/**
 * Server-side identity resolution. The agent's free-text query is only a hint: an exact match
 * on the customer's name or preferred name wins; otherwise every query token must appear in a
 * name. More than one candidate is ambiguous and the server asks for clarification.
 */
export function resolveCustomer(query: string, candidates: readonly CustomerCandidate[]): CustomerResolution {
  const wanted = normalise(query);
  if (!wanted) return { kind: 'none' };
  const exact = candidates.filter(
    (candidate) => normalise(candidate.name) === wanted || (candidate.preferredName !== null && normalise(candidate.preferredName) === wanted),
  );
  if (exact.length === 1) return { kind: 'resolved', customer: exact[0]!, basis: 'exact_name' };
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact };
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return { kind: 'none' };
  const partial = candidates.filter((candidate) => {
    const nameTokens = new Set([...tokens(candidate.name), ...tokens(candidate.preferredName ?? '')]);
    return queryTokens.every((token) => nameTokens.has(token));
  });
  if (partial.length === 1) return { kind: 'resolved', customer: partial[0]!, basis: 'surname' };
  if (partial.length > 1) return { kind: 'ambiguous', matches: partial };
  return { kind: 'none' };
}
