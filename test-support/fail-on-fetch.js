globalThis.fetch = async () => {
  throw new Error("Unexpected network fetch during offline onboarding test.");
};