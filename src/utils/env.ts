export function validateEnv(requiredKeys: string[] = []): void {
  const missing = requiredKeys.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(
      `Missing environment variables: ${missing.join(', ')}. KuCoin passphrase is the string you set when creating the API key (not your trading password).`
    );
  }
}

