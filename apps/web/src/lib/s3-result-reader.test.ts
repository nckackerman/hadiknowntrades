import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { S3ResultReader } from "./s3-result-reader";

function fakeClient(
  send: ReturnType<typeof vi.fn>,
): ConstructorParameters<typeof S3ResultReader>[1] {
  return { send } as unknown as S3Client;
}

describe("S3ResultReader", () => {
  it("sends a GetObjectCommand with the bucket and key, and returns the body as a string", async () => {
    const send = vi.fn().mockResolvedValue({
      Body: { transformToString: vi.fn().mockResolvedValue('{"hello":"world"}') },
    });
    const reader = new S3ResultReader("my-bucket", fakeClient(send));

    const body = await reader.getObject("results/1M.json");

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: "my-bucket", Key: "results/1M.json" });
    expect(body).toBe('{"hello":"world"}');
  });

  it("returns null when the object doesn't exist (NoSuchKey)", async () => {
    const send = vi.fn().mockRejectedValue(new NoSuchKey({ message: "not found", $metadata: {} }));
    const reader = new S3ResultReader("my-bucket", fakeClient(send));

    const body = await reader.getObject("results/1M.json");

    expect(body).toBeNull();
  });

  it("returns null when the response has no Body", async () => {
    const send = vi.fn().mockResolvedValue({});
    const reader = new S3ResultReader("my-bucket", fakeClient(send));

    const body = await reader.getObject("results/1M.json");

    expect(body).toBeNull();
  });

  it("propagates any other error instead of swallowing it", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access denied"));
    const reader = new S3ResultReader("my-bucket", fakeClient(send));

    await expect(reader.getObject("results/1M.json")).rejects.toThrow("access denied");
  });
});
