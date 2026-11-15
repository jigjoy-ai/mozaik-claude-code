import { afterAll, beforeAll, describe, expect, test } from "@rstest/core"
import { existsSync, mkdtempSync } from "node:fs"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createApp } from "mozaik-network/src/app"
import { initNetworkModule, resolveNetworkModule } from "mozaik-network/src/network-module"

type ChannelEvent = { content: string; meta: Record<string, string> }

type Session = {
	events: ChannelEvent[]
	call(tool: string, args?: Record<string, unknown>): Promise<{ text: string; failed: boolean }>
}

let server: Server
let origin: string
const clients: Client[] = []

beforeAll(async () => {
	initNetworkModule()
	server = createApp()
	await new Promise<void>((resolve) => server.listen(0, resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
	await Promise.all(clients.map((client) => client.close()))
	await new Promise((resolve) => server.close(resolve))
})

const stateDir = () => mkdtempSync(join(tmpdir(), "mozaik-network-"))

/** The plugin's server as Claude Code runs it: over stdio, with what it pushes into the session kept in `events`. */
async function session(name: string, dir: string): Promise<Session> {
	const client = new Client({ name: "claude-code", version: "0.0.0" })
	const events: ChannelEvent[] = []
	client.fallbackNotificationHandler = async (notification) => {
		if (notification.method === "notifications/claude/channel") events.push(notification.params as ChannelEvent)
	}

	await client.connect(
		new StdioClientTransport({
			command: "node_modules/.bin/tsx",
			args: ["src/server.ts"],
			env: {
				...(process.env as Record<string, string>),
				NETWORK_ORIGIN: origin,
				MOZAIK_PEER_NAME: name,
				MOZAIK_NETWORK_STATE_DIR: dir,
			},
		}),
	)
	clients.push(client)

	return {
		events,
		async call(tool, args = {}) {
			const result = await client.callTool({ name: tool, arguments: args })
			const [{ text }] = result.content as { text: string }[]
			return { text, failed: result.isError === true }
		},
	}
}

async function until(condition: () => boolean): Promise<void> {
	for (let waited = 0; !condition(); waited += 20) {
		if (waited > 3000) throw new Error("waited 3s for nothing")
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

describe("Claude Code plugin", () => {
	test("one session makes a network, another joins with its link, and each is shown what the other says", async () => {
		const [ana, marko] = await Promise.all([session("ana@api", stateDir()), session("marko@web", stateDir())])

		const made = await ana.call("create_network", { name: "team" })
		const link = made.text.split("\n").pop()!
		expect(link).toMatch(new RegExp(`^${origin}#nt_`))

		const joined = await marko.call("join_network", { invite: link })
		expect(joined.text).toContain("ana@api")
		expect(joined.text).toContain("marko@web")

		await ana.call("send_message", { text: "who is on the login bug?" })
		await until(() => marko.events.length === 1)
		expect(marko.events[0]).toMatchObject({
			content: "who is on the login bug?",
			meta: { kind: "message", from: "ana@api", direct: "false" },
		})

		await marko.call("send_message", { text: "me", to: "ana@api" })
		await until(() => ana.events.length === 1)
		expect(ana.events[0]).toMatchObject({ content: "me", meta: { from: "marko@web", direct: "true" } })

		expect((await ana.call("read_messages")).text).toMatch(
			/ana@api: who is on the login bug\?\n.* marko@web → ana@api: me$/,
		)
		expect((await marko.call("send_message", { text: "hi", to: "nobody" })).failed).toBe(true)
	})

	test("a session the network forgot comes back by itself, as a new peer", async () => {
		const [ana, marko] = await Promise.all([session("ana@api", stateDir()), session("marko@web", stateDir())])
		const link = (await ana.call("create_network", { name: "team" })).text.split("\n").pop()!
		await marko.call("join_network", { invite: link })

		// The network forgets its peers and drops their connections: what happens once the ones it kept have gone.
		const { peerRepository, envelopeDelivery } = resolveNetworkModule()
		const forgotten = peerRepository as unknown as { peers: Map<string, unknown> }
		const delivery = envelopeDelivery as unknown as { connections: Map<string, Set<{ terminate(): void }>> }
		forgotten.peers.clear()
		for (const sockets of delivery.connections.values()) for (const socket of sockets) socket.terminate()

		const told = (s: Session) => s.events.find((event) => event.meta.kind === "error")
		await until(() => told(ana) !== undefined && told(marko) !== undefined)
		expect(told(marko)!.content).toMatch(/joined again as a new peer/)

		// Both are in the network again, under their names, and hear each other.
		await marko.call("send_message", { text: "still here?" })
		await until(() => ana.events.some((event) => event.content === "still here?"))
		expect(ana.events.find((event) => event.content === "still here?")!.meta.from).toBe("marko@web")
	})

	test("joining from inside a network leaves it first: the same one again, or another", async () => {
		const [ana, marko, cara] = await Promise.all([
			session("ana@api", stateDir()),
			session("marko@web", stateDir()),
			session("cara@ops", stateDir()),
		])
		const team = (await ana.call("create_network", { name: "team" })).text.split("\n").pop()!
		const ops = (await cara.call("create_network", { name: "ops" })).text.split("\n").pop()!
		await marko.call("join_network", { invite: team })

		const again = await marko.call("join_network")
		expect(again.failed).toBe(false)
		expect(again.text).toContain("ana@api")

		const moved = await marko.call("join_network", { invite: ops })
		expect(moved.text).toContain("cara@ops")
		expect(moved.text).not.toContain("ana@api")
	})

	test("a later session on the same machine is told a network is saved, and joins it without the link", async () => {
		const dir = stateDir()
		const first = await session("ana@api", dir)
		await first.call("create_network", { name: "team" })
		await first.call("send_message", { text: "said before you came" })

		const later = await session("ana@docs", dir)
		await until(() => later.events.length === 1)
		expect(later.events[0]).toMatchObject({ meta: { kind: "ready" } })

		expect((await later.call("join_network")).text).toContain("ana@api")
		expect((await later.call("read_messages")).text).toContain("ana@api: said before you came")

		await later.call("leave_network", { forget: true })
		expect((await later.call("list_peers")).text).toBe("Not in a network.")
		expect(existsSync(join(dir, "network.json"))).toBe(false)
	})

	test("without a saved network or a link there is nothing to join", async () => {
		const alone = await session("ana@api", stateDir())

		expect(await alone.call("join_network")).toMatchObject({ failed: true })
		expect(await alone.call("join_network", { invite: "not a link" })).toMatchObject({ failed: true })
		expect(await alone.call("send_message", { text: "anyone?" })).toMatchObject({ failed: true })
		expect(alone.events).toEqual([])
	})
})
