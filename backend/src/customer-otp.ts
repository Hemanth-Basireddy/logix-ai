export type TwilioVerifyConfig = {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
};

export class OtpProviderUnavailableError extends Error {}
export class OtpProviderError extends Error {}

export type OtpProvider = {
  start(phoneE164: string): Promise<void>;
  check(phoneE164: string, code: string): Promise<boolean>;
};

export function createTwilioVerifyProvider(
  config: TwilioVerifyConfig,
  fetcher: typeof fetch = fetch,
): OtpProvider {
  const { accountSid, authToken, verifyServiceSid } = config;
  if (!accountSid || !authToken || !verifyServiceSid) {
    throw new OtpProviderUnavailableError("Phone verification is not configured.");
  }
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifyServiceSid)}`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;

  async function post(path: string, values: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher(`${base}/${path}`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(values),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new OtpProviderError("Phone verification is temporarily unavailable.");
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new OtpProviderError("Phone verification is temporarily unavailable.");
    return payload;
  }

  return {
    async start(phoneE164) {
      const result = await post("Verifications", { To: phoneE164, Channel: "sms" });
      if (result.status !== "pending") throw new OtpProviderError("Phone verification is temporarily unavailable.");
    },
    async check(phoneE164, code) {
      const result = await post("VerificationCheck", { To: phoneE164, Code: code });
      return result.status === "approved";
    },
  };
}
