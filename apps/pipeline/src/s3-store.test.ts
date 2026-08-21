import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { S3ResultStore } from "./s3-store.js";

describe("S3ResultStore", () => {
  it("sends a PutObjectCommand with the bucket, key, body, and JSON content type", async () => {
    const send = vi.fn().mockResolvedValue({});
    const fakeClient = { send } as unknown as ConstructorParameters<typeof S3ResultStore>[1];

    const store = new S3ResultStore("my-bucket", fakeClient);
    await store.putObject("results/1M.json", '{"hello":"world"}');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "my-bucket",
      Key: "results/1M.json",
      Body: '{"hello":"world"}',
      ContentType: "application/json",
    });
  });

  it("propagates an error from the S3 client instead of swallowing it", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access denied"));
    const fakeClient = { send } as unknown as ConstructorParameters<typeof S3ResultStore>[1];
    const store = new S3ResultStore("my-bucket", fakeClient);

    await expect(store.putObject("results/1M.json", "{}")).rejects.toThrow("access denied");
  });
});
