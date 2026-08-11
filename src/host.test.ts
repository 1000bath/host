import { describe, expect, it } from "vitest";
import { Host, type Mailbox } from "./host.js";

describe("Host", () => {
	let host: Host;
	let alice: Mailbox;
	let bob: Mailbox;

	function fresh(): void {
		host = new Host();
		alice = host.register("alice");
		bob = host.register("bob");
	}

	it("routes direct messages to the recipient's mailbox only", () => {
		fresh();
		alice.send("bob", "hey bob");
		alice.send("bob", "and another");

		expect(bob.read()).toHaveLength(2);
		// sender does not receive its own direct message
		expect(alice.read()).toHaveLength(0);
	});

	it("broadcast reaches every mailbox except the sender", () => {
		fresh();
		const carol = host.register("carol");
		alice.broadcast("hello everyone");

		expect(bob.read()).toHaveLength(1);
		expect(carol.read()).toHaveLength(1);
		expect(alice.read()).toHaveLength(0);
	});

	it("read drains the mailbox; second read is empty", () => {
		fresh();
		alice.send("bob", "only one");
		expect(bob.read()).toHaveLength(1);
		expect(bob.read()).toHaveLength(0);
	});

	it("topic filter reads only matching messages", () => {
		fresh();
		alice.send("bob", "urgent", { topic: "ops" });
		alice.send("bob", "chatter", { topic: "general" });

		const ops = bob.read({ topic: "ops" });
		expect(ops).toHaveLength(1);
		expect(ops[0].content).toBe("urgent");

		// the untouched "general" message is still pending
		expect(bob.read({ topic: "general" })).toHaveLength(1);
	});

	it("after cursor filters what is drained", () => {
		fresh();
		alice.send("bob", "first"); // id 1
		const first = bob.read({ after: "0" });
		expect(first).toHaveLength(1);
		expect(first[0].content).toBe("first");

		alice.send("bob", "second"); // id 2
		// only messages after the cursor match and get drained
		const later = bob.read({ after: first[0].id });
		expect(later).toHaveLength(1);
		expect(later[0].content).toBe("second");
	});

	it("global log keeps everything, read-only", () => {
		fresh();
		alice.send("bob", "a");
		bob.send("alice", "b");
		alice.broadcast("c");

		expect(host.log()).toHaveLength(3);
		// log is not drainable
		expect(host.log()).toHaveLength(3);
	});

	it("register is idempotent; unregister drops pending messages", () => {
		fresh();
		alice.send("bob", "queued while bob not reading");

		expect(host.register("bob")).toBe(bob);
		host.unregister("bob");
		expect(host.list()).toEqual(["alice"]);
		expect(host.read("bob")).toHaveLength(0);
	});

	it("send to unregistered agent throws, future ids stay stable", () => {
		fresh();
		expect(() => alice.send("ghost", "nope")).toThrow(/not registered/);

		const msg = alice.send("bob", "after failure");
		expect(msg.id).toBe("1");
	});

	it("subscribe receives every relayed message", () => {
		fresh();
		const seen: string[] = [];
		const unsubscribe = host.subscribe((m) => seen.push(m.content as string));

		alice.send("bob", "direct");
		alice.broadcast("wide");

		expect(seen).toEqual(["direct", "wide"]);
		unsubscribe();
		alice.send("bob", "not seen");
		expect(seen).toHaveLength(2);
	});
});