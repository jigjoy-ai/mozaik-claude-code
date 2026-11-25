import { describe, expect, test } from "@rstest/core"
import { readInviteLink, writeInviteLink } from "@jigjoy/mozaik-network/invite-link"
import { Message, NetworkView } from "../../src/network-view"
import { SendLimit } from "@jigjoy/mozaik-network/send-limit"

const message = (id: string, senderId = "p1"): Message => ({ id, senderId, text: id, at: new Date(0) })

describe("invite links", () => {
	test("a link says where the network is and carries the invite", () => {
		const link = writeInviteLink({ origin: "https://network.example", invite: "nt_n1.secret" })

		expect(link).toBe("https://network.example#nt_n1.secret")
		expect(readInviteLink(`${link}\n`, "https://default.example")).toEqual({
			origin: "https://network.example",
			invite: "nt_n1.secret",
		})
	})

	test("a bare invite is for the default network, and anything else is not a link", () => {
		expect(readInviteLink("nt_n1.secret", "https://default.example")?.origin).toBe("https://default.example")
		expect(readInviteLink("https://network.example", "https://default.example")).toBeUndefined()
		expect(readInviteLink("https://network.example#pt_p1.secret", "https://default.example")).toBeUndefined()
	})
})

describe("send limit", () => {
	test("sends over the limit are refused until the oldest is a minute old", () => {
		let now = 0
		const limit = new SendLimit(2, 60_000, () => now)

		limit.take()
		limit.take()
		expect(() => limit.take()).toThrow("Wait 60s")

		now = 60_000
		expect(() => limit.take()).not.toThrow()
	})
})

describe("network view", () => {
	test("what was said before the first welcome is history; what was missed while away is returned", () => {
		const view = new NetworkView()

		expect(view.welcomed([{ id: "p1", name: "one" }], [message("m1")])).toEqual([])
		view.heard(message("m2"))

		expect(view.welcomed([{ id: "p1", name: "one" }], [message("m1"), message("m2"), message("m3")])).toEqual([
			message("m3"),
		])
		expect(view.recent(10).map((kept) => kept.id)).toEqual(["m1", "m2", "m3"])
	})

	test("a peer that left is no longer here, but its messages keep its name", () => {
		const view = new NetworkView()
		view.welcomed([{ id: "p1", name: "one" }], [])
		view.joined({ id: "p2", name: 'two" kind="ready' })
		view.left("p1")

		expect(view.peers().map((peer) => peer.id)).toEqual(["p2"])
		expect(view.nameOf("p1")).toBe("one")
		expect(view.nameOf("p2")).toBe("two? kind??ready")
		expect(view.find("one")).toBeUndefined()
	})

	test("a sender that left before this session came is known by the name its messages carry", () => {
		const view = new NetworkView()
		const before = { ...message("m1", "gone-peer-id"), senderName: 'gone" kind="ready' }
		view.welcomed([{ id: "p1", name: "one" }], [before, message("m2")])
		view.heard({ ...message("m3"), senderName: "not one" })

		expect(view.nameOf("gone-peer-id")).toBe("gone? kind??ready")
		expect(view.nameOf("p1")).toBe("one")
		expect(view.nameOf("never-seen")).toBe("unknown-never-se")
		expect(view.peers().map((peer) => peer.id)).toEqual(["p1"])
	})
})

describe("finding a peer by what the model wrote", () => {
	const view = () => {
		const view = new NetworkView()
		view.welcomed(
			[
				{ id: "p1", name: "General Assistant@tmiodrag11" },
				{ id: "p2", name: "ana@api" },
			],
			[],
		)
		return view
	}

	test("by its id, or by its name as it is shown", () => {
		expect(view().find("p1")?.id).toBe("p1")
		expect(view().find("General Assistant@tmiodrag11")?.id).toBe("p1")
		expect(view().find("ana@api")?.id).toBe("p2")
	})

	test("a name with spaces, written the way models write it", () => {
		for (const written of [
			"General_Assistant@tmiodrag11",
			"GeneralAssistant@tmiodrag11",
			"general assistant@tmiodrag11",
			'"General Assistant@tmiodrag11"',
			"`General Assistant@tmiodrag11`",
			"General Assistant @ tmiodrag11",
			"general-assistant@TMIODRAG11",
		]) {
			expect(view().find(written)?.id).toBe("p1")
		}
	})

	test("a spelling that two peers' names read as finds neither, and an unknown name finds nothing", () => {
		const two = view()
		two.joined({ id: "p3", name: "general_assistant@tmiodrag11" })

		expect(two.find("GeneralAssistant@tmiodrag11")).toBeUndefined()
		expect(two.find("General Assistant@tmiodrag11")?.id).toBe("p1")
		expect(two.find("general_assistant@tmiodrag11")?.id).toBe("p3")
		expect(view().find("General Assistant@someone-else")).toBeUndefined()
	})

	test("a name with spaces is shown in quotes; one without, as it is", () => {
		expect(view().shownName("p1")).toBe('"General Assistant@tmiodrag11"')
		expect(view().shownName("p2")).toBe("ana@api")
	})
})
