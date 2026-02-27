import { test, expect, mock, spyOn, afterEach } from "bun:test"
import path from "path"

// Prevent real package installations during tests
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      const lastAtIndex = pkg.lastIndexOf("@")
      return lastAtIndex > 0 ? pkg.substring(0, lastAtIndex) : pkg
    },
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))

const mockPlugin = () => ({})
mock.module("opencode-copilot-auth", () => ({ default: mockPlugin }))
mock.module("opencode-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/opencode-gitlab-auth", () => ({ default: mockPlugin }))

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"

const LIVE_MODELS = [
  "mlx-community/qwen3.5-35b-a3b",
  "qwen/qwen3-1.7b",
  "microsoft/phi-4-reasoning-plus",
]

function makeFetch(impl: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  const fn = impl as typeof fetch
  fn.preconnect = () => {}
  return fn
}

function mockFetchWithModels(models: string[]) {
  return spyOn(globalThis, "fetch").mockImplementation(
    makeFetch(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/models")) {
        return new Response(
          JSON.stringify({ data: models.map((id) => ({ id })) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }),
  )
}

afterEach(() => {
  // Restore fetch after each test
  mock.restore()
})

test("LM Studio: loader autoloads when /v1/models responds", async () => {
  const spy = mockFetchWithModels(LIVE_MODELS)
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["lmstudio"]).toBeDefined()
      expect(providers["lmstudio"].source).toBe("custom")
    },
  })
  spy.mockRestore()
})

test("LM Studio: only installed models are listed", async () => {
  const spy = mockFetchWithModels(LIVE_MODELS)
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const modelIDs = Object.keys(providers["lmstudio"].models)
      expect(modelIDs).toContain("mlx-community/qwen3.5-35b-a3b")
      expect(modelIDs).toContain("qwen/qwen3-1.7b")
      expect(modelIDs).toContain("microsoft/phi-4-reasoning-plus")
      // Only the 3 live models, nothing else
      expect(modelIDs.length).toBe(3)
    },
  })
  spy.mockRestore()
})

test("LM Studio: synthetic models have required fields", async () => {
  const spy = mockFetchWithModels(["my-org/custom-llm"])
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["lmstudio"].models["my-org/custom-llm"]
      expect(model).toBeDefined()
      expect(model.id).toBe("my-org/custom-llm")
      expect(model.providerID).toBe("lmstudio")
      expect(model.api.id).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.cost).toBeDefined()
      expect(model.limit).toBeDefined()
      expect(model.capabilities).toBeDefined()
    },
  })
  spy.mockRestore()
})

test("LM Studio: does not autoload when /v1/models is unreachable", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    makeFetch(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1234") }),
  )
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      // When LM Studio is offline, provider should not be loaded
      expect(providers["lmstudio"]).toBeUndefined()
    },
  })
  spy.mockRestore()
})

test("LM Studio: does not autoload when /v1/models returns non-ok status", async () => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    makeFetch(async () => new Response("Internal Server Error", { status: 500 })),
  )
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["lmstudio"]).toBeUndefined()
    },
  })
  spy.mockRestore()
})

test("LM Studio: respects custom baseURL from config", async () => {
  const CUSTOM_BASE = "http://10.0.0.1:8080/v1"
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    makeFetch(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(CUSTOM_BASE)) {
        return new Response(
          JSON.stringify({ data: [{ id: "test/model" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }),
  )
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            lmstudio: {
              options: { baseURL: CUSTOM_BASE },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["lmstudio"]).toBeDefined()
      expect(providers["lmstudio"].options.baseURL).toBe(CUSTOM_BASE)
    },
  })
  spy.mockRestore()
})

test("LM Studio: disabled_providers prevents loading", async () => {
  const spy = mockFetchWithModels(LIVE_MODELS)
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["lmstudio"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["lmstudio"]).toBeUndefined()
    },
  })
  spy.mockRestore()
})
