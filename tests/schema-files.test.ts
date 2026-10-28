import { describe, expect, it } from "vitest";
import { isNoiseFile, relativeProtoPath } from "../src/panel/schema-files";

describe("isNoiseFile", () => {
  it("ignores Unity metadata and other non-schema files", () => {
    for (const name of [
      "lobby.proto.meta",
      "realtime.meta",
      "google.meta",
      "realtime.proto.import",
      ".DS_Store",
      "notes.txt",
      "bundle.js",
      "config.json",
    ]) {
      expect(isNoiseFile(name), name).toBe(true);
    }
  });

  it("keeps .proto files", () => {
    expect(isNoiseFile("lobby.proto")).toBe(false);
    expect(isNoiseFile("realtime/realtime.proto")).toBe(false);
  });
});

describe("relativeProtoPath", () => {
  it("strips the folder the user picked, keeping the structure below it", () => {
    expect(relativeProtoPath("realtime.proto", "proto/realtime/realtime.proto")).toBe(
      "realtime/realtime.proto",
    );
    expect(relativeProtoPath("struct.proto", "proto/google/protobuf/struct.proto")).toBe(
      "google/protobuf/struct.proto",
    );
  });

  it("keeps a file at the root of the picked folder at the root", () => {
    expect(relativeProtoPath("lobby.proto", "proto/lobby.proto")).toBe("lobby.proto");
  });

  it("falls back to the bare name when no folder was picked", () => {
    expect(relativeProtoPath("lobby.proto", undefined)).toBe("lobby.proto");
    expect(relativeProtoPath("lobby.proto", "")).toBe("lobby.proto");
  });

  it("collapses empty segments", () => {
    expect(relativeProtoPath("a.proto", "proto//a.proto")).toBe("a.proto");
  });
});
