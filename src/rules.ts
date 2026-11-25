import {
	CommandContract,
	commandRegistry,
	Condition,
	ConditionContract,
	InputResolver,
	InputResolverContract,
	PolicyDefinition,
} from "@jigjoy/mozaik-rule-engine"
import { Envelope } from "@jigjoy/mozaik-network/envelope"
import { Channel } from "./channel"
import { Message, NetworkView, PeerInfo } from "./network-view"

type MessageSent = Envelope<{ message: string; senderName?: string; to?: string }>

type Refusal = { code: string; message: string }

/** How a Claude Code session acts on what happens in the network. */
export const claudeCodePolicy: PolicyDefinition = {
	rules: [
		{ condition: "message.received", inputResolver: "message", command: "claude_code.notify" },
		{ condition: "membership.changed", inputResolver: "envelope", command: "network.observe" },
		{ condition: "request.refused", inputResolver: "refusal", command: "claude_code.report" },
	],
}

@Condition({ name: "message.received" })
export class MessageReceivedCondition extends ConditionContract<Envelope<any>> {
	isSatisfiedBy(envelope: Envelope<any>) {
		return envelope.type === "message.sent"
	}
}

@Condition({ name: "membership.changed" })
export class MembershipChangedCondition extends ConditionContract<Envelope<any>> {
	isSatisfiedBy(envelope: Envelope<any>) {
		return ["peer.welcomed", "peer.joined", "peer.left"].includes(envelope.type)
	}
}

@Condition({ name: "request.refused" })
export class RequestRefusedCondition extends ConditionContract<Envelope<any>> {
	isSatisfiedBy(envelope: Envelope<any>) {
		return envelope.type === "error"
	}
}

@InputResolver({ name: "message" })
export class MessageInput implements InputResolverContract<MessageSent, Message> {
	resolve(envelope: MessageSent): Promise<Message> {
		return Promise.resolve(toMessage(envelope))
	}
}

@InputResolver({ name: "envelope" })
export class EnvelopeInput implements InputResolverContract<Envelope<unknown>, Envelope<unknown>> {
	resolve(envelope: Envelope<unknown>): Promise<Envelope<unknown>> {
		return Promise.resolve(envelope)
	}
}

@InputResolver({ name: "refusal" })
export class RefusalInput implements InputResolverContract<Envelope<Refusal>, Refusal> {
	resolve(envelope: Envelope<Refusal>): Promise<Refusal> {
		return Promise.resolve(envelope.payload)
	}
}

/** Shows a peer's message to Claude and keeps it for read_messages. */
export class NotifyClaudeCode implements CommandContract {
	readonly id = "claude_code.notify"

	constructor(
		private readonly view: NetworkView,
		private readonly channel: Channel,
	) {}

	async invoke(input: unknown): Promise<void> {
		const message = input as Message

		this.view.heard(message)
		await show(this.channel, this.view, message)
	}
}

/** Keeps up with who is in the network. Nobody's coming or going is shown to Claude: list_peers answers that. */
export class ObserveNetwork implements CommandContract {
	readonly id = "network.observe"

	constructor(
		private readonly view: NetworkView,
		private readonly channel: Channel,
	) {}

	async invoke(input: unknown): Promise<void> {
		const envelope = input as Envelope<any>

		switch (envelope.type) {
			case "peer.welcomed": {
				const { peers, messages } = envelope.payload as { peers: PeerInfo[]; messages: MessageSent[] }
				// Welcomed again after the connection dropped: what was said meanwhile is shown now.
				const missed = this.view.welcomed(peers, messages.map(toMessage))
				for (const message of missed) await show(this.channel, this.view, message)
				break
			}

			case "peer.joined":
				this.view.joined(envelope.payload as PeerInfo)
				break

			case "peer.left":
				this.view.left((envelope.payload as { peerId: string }).peerId)
				break
		}
	}
}

/**
 * Tells Claude what the network refused: a message that wasn't sent would otherwise look sent.
 * A network that no longer knows the session is not left for Claude to sort out: the session
 * comes back by itself, and Claude is told how that went.
 */
export class ReportRefusal implements CommandContract {
	readonly id = "claude_code.report"

	constructor(
		private readonly channel: Channel,
		private readonly comeBack: () => Promise<boolean>,
	) {}

	async invoke(input: unknown): Promise<void> {
		const { code, message } = input as Refusal

		if (code !== "unauthorized") {
			await this.channel.push(`The network refused the last request: ${message}`, { kind: "error", code })
			return
		}

		const back = await this.comeBack()
		await this.channel.push(
			back
				? "The network no longer knew this session, so it joined again as a new peer. What was sent just before may not have arrived: send it again if it matters."
				: "The network no longer knows this session, and the saved invite no longer lets it in. Ask your user for a new invite link and call join_network with it.",
			{ kind: "error", code },
		)
	}
}

export function registerCommands(view: NetworkView, channel: Channel, comeBack: () => Promise<boolean>): void {
	const commands = [
		new NotifyClaudeCode(view, channel),
		new ObserveNetwork(view, channel),
		new ReportRefusal(channel, comeBack),
	]

	for (const command of commands) commandRegistry.register(command.id, command)
}

function toMessage(envelope: MessageSent): Message {
	return {
		id: envelope.id,
		senderId: envelope.senderId,
		senderName: envelope.payload.senderName,
		text: envelope.payload.message,
		to: envelope.payload.to,
		at: new Date(envelope.createdAt),
	}
}

/** A message as Claude gets it: the text, with who sent it and whether it was for this session only. */
function show(channel: Channel, view: NetworkView, message: Message): Promise<void> {
	return channel.push(message.text, {
		kind: "message",
		from: view.nameOf(message.senderId),
		from_id: message.senderId,
		direct: String(message.to !== undefined),
	})
}
