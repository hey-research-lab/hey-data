/**
 * No test may touch the network. The generator takes an injected `fetchImpl`,
 * so any call reaching the real `fetch` is a mistake: fail loudly instead of
 * silently making a request.
 */
const blocked = async (input: unknown): Promise<never> => {
  const target = typeof input === 'string' ? input : String(input);
  throw new Error(
    `Network access is disabled in tests. Something tried to fetch ${target}. ` +
      'Drive the generator with a stubbed fetchImpl over saved fixtures.',
  );
};

globalThis.fetch = blocked as unknown as typeof fetch;
