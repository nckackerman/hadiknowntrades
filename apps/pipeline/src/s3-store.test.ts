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

  it("getObject reads back a previously-written body as a string", async () => {
    const send = vi.fn().mockResolvedValue({
      Body: { transformToString: async () => '{"hello":"world"}' },
    });
    const fakeClient = { send } as unknown as ConstructorParameters<typeof S3ResultStore>[1];
    const store = new S3ResultStore("my-bucket", fakeClient);

    const body = await store.getObject("results/lineup/history.json");

    expect(body).toBe('{"hello":"world"}');
    const command = send.mock.calls[0]?.[0];
    expect(command.input).toEqual({ Bucket: "my-bucket", Key: "results/lineup/history.json" });
  });

  it("getObject returns null for a NoSuchKey error (issue #208 -- the object hasn't been written yet)", async () => {
    const error = new Error("The specified key does not exist.");
    error.name = "NoSuchKey";
    const send = vi.fn().mockRejectedValue(error);
    const fakeClient = { send } as unknown as ConstructorParameters<typeof S3ResultStore>[1];
    const store = new S3ResultStore("my-bucket", fakeClient);

    await expect(store.getObject("results/lineup/history.json")).resolves.toBeNull();
  });

  it("getObject propagates any other error, not just NoSuchKey", async () => {
    const send = vi.fn().mockRejectedValue(new Error("access denied"));
    const fakeClient = { send } as unknown as ConstructorParameters<typeof S3ResultStore>[1];
    const store = new S3ResultStore("my-bucket", fakeClient);

    await expect(store.getObject("results/lineup/history.json")).rejects.toThrow("access denied");
  });
});
