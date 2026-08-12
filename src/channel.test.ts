import { describe, expect, it } from "vitest";
import { Host, type Mailbox } from "./host.js";

describe("channel isolation", () => {
	function fresh(): { host: Host; alice: Mailbox; bob: Mailbox; carol: Mailbox } {
		const host = new Host();
		const alice = host.register("alice");
		const bob = host.register("bob");
		const carol = host.register("carol");
		return { host, alice, bob, carol };
	}

	it("unmanaged topics stay fully open", () => {
		const { host, alice, bob } = fresh();
		alice.send("bob", "ping", { topic: "general" });
		expect(bob.read({ topic: "general" })).toHaveLength(1);
		expect(host.log({ as: "alice" })).toHaveLength(1);
	});

	it("owner creates a channel and non-members cannot send on it", () => {
		const { host, alice, bob } = fresh();
		host.manageChannel("secret", "alice");
		expect(host.listChannels()[0].members.has("alice")).toBe(true);

		expect(() => bob.send("alice", "sneak", { topic: "secret" })).toThrow(/not a member/);
		expect(() => bob.broadcast("sneak", { topic: "secret" })).toThrow(/not a member/);
	});

	it("broadcast on a channel only reaches members", () => {
		const { host, alice, bob, carol } = fresh();
		host.manageChannel("team", "alice");
		host.addChannelMember("team", "alice", "bob");

		alice.broadcast("for the team", { topic: "team" });

		expect(bob.read({ topic: "team" })).toHaveLength(1);
		// carol never received it (and cannot read the channel scope)
		expect(carol.read()).toHaveLength(0);
		expect(() => carol.read({ topic: "team" })).toThrow(/not a member/);
	});

	it("reads are blocked for non-members on a channel scope", () => {
		const { host, alice, bob, carol } = fresh();
		host.manageChannel("ops", "alice");
		alice.send("bob", "workers only", { topic: "ops" });

		// bob got the direct message but can't read the channel scope
		expect(() => bob.read({ topic: "ops" })).toThrow(/not a member/);
		// carol never got it and can't peek either
		expect(() => carol.read({ topic: "ops" })).toThrow(/not a member/);
	});

	it("an inbox-wide read (no topic) still works and sees the channel message", () => {
		const { host, alice, bob } = fresh();
		host.manageChannel("ops", "alice");
		alice.send("bob", "direct inside", { topic: "ops" });

		// bob reads his own mailbox without a topic filter → allowed
		const got = bob.read();
		expect(got).toHaveLength(1);
		expect(got[0].topic).toBe("ops");
	});

	it("log with as= hides channel messages the viewer cannot access", () => {
		const { host, alice, bob } = fresh();
		host.manageChannel("ops", "alice");
		host.addChannelMember("ops", "alice", "bob");
		alice.send("bob", "inside", { topic: "ops" });
		alice.broadcast("public", { topic: "general" });

		// open topic visible to everyone (carol is not a member of ops)
		expect(host.log({ as: "carol" })).toHaveLength(1);
		expect(host.log({ as: "carol" })[0].topic).toBe("general");
		// bob is a member → sees both
		expect(host.log({ as: "bob" })).toHaveLength(2);
	});
});