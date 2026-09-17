process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-only-key-no-provider-access';

globalThis.fetch = async () => {
  throw new Error('External network access is disabled in isolated AI Engine tests.');
};
