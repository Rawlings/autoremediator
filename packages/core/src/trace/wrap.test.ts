import { describe, expect, it } from "vitest";

import { wrapFunction, wrapModuleExports, type Counter, type WrapSink } from "./wrap.js";

function sink(): WrapSink & { counts: Map<string, Counter>; skipped: Map<string, string> } {
  const counts = new Map<string, Counter>();
  const skipped = new Map<string, string>();
  return {
    counts,
    skipped,
    counter(name) {
      let counter = counts.get(name);
      if (!counter) {
        counter = { n: 0 };
        counts.set(name, counter);
      }
      return counter;
    },
    skip(name, reason) {
      skipped.set(name, reason);
    },
  };
}

const n = (s: ReturnType<typeof sink>, name: string): number | undefined => s.counts.get(name)?.n;

describe("wrapFunction", () => {
  it("passes this, arguments and return values through and counts each call", () => {
    const s = sink();
    const fn = function (this: { tag: string }, a: number, b: number) {
      return `${this.tag}${String(a + b)}`;
    };
    const wrapped = wrapFunction(fn as (...args: unknown[]) => unknown, ["fn"], s);
    expect(wrapped.call({ tag: "t" }, 1, 2)).toBe("t3");
    expect(wrapped.apply({ tag: "u" }, [2, 2])).toBe("u4");
    expect(n(s, "fn")).toBe(2);
    expect(wrapped.name).toBe("fn");
    expect(wrapped).toHaveLength(2);
  });

  it("propagates exceptions and still counts the call", () => {
    const s = sink();
    const wrapped = wrapFunction(
      () => {
        throw new TypeError("nope");
      },
      ["boom"],
      s,
    );
    expect(() => wrapped()).toThrow(TypeError);
    expect(n(s, "boom")).toBe(1);
  });

  it("works with async functions, generators and new on a plain function", async () => {
    const s = sink();
    const asyncFn = wrapFunction(async () => 5, ["a"], s);
    await expect(asyncFn()).resolves.toBe(5);
    const gen = wrapFunction(
      function* () {
        yield 1;
        yield 2;
      },
      ["g"],
      s,
    );
    expect([...(gen() as Iterable<number>)]).toEqual([1, 2]);
    function Plain(this: { x?: number }) {
      this.x = 1;
    }
    const WrappedPlain = wrapFunction(
      Plain as unknown as (...args: unknown[]) => unknown,
      ["p"],
      s,
    );
    const made = new (WrappedPlain as unknown as new () => { x: number })();
    expect(made.x).toBe(1);
    expect(made instanceof Plain).toBe(true);
    expect(n(s, "p")).toBe(1);
  });

  it("returns the same wrapper for the same function and counts under every name once", () => {
    const s = sink();
    const fn = () => 1;
    const first = wrapFunction(fn, ["a"], s);
    const second = wrapFunction(fn, ["b"], s);
    const third = wrapFunction(fn, ["a"], s);
    expect(second).toBe(first);
    expect(third).toBe(first);
    first();
    expect(n(s, "a")).toBe(1);
    expect(n(s, "b")).toBe(1);
  });

  it("does not wrap a wrapper again", () => {
    const s = sink();
    const wrapped = wrapFunction(() => 1, ["a"], s);
    expect(wrapFunction(wrapped, ["b"], s)).toBe(wrapped);
  });

  it("never wraps classes: instanceof, new.target, identity and static private fields are untouched", () => {
    const s = sink();
    class Base {
      id = 1;
      constructor() {
        if (new.target === Base) throw new Error("abstract");
      }
    }
    class Guarded {
      static #count = 0;
      id = 2;
      static next() {
        return ++Guarded.#count;
      }
    }
    expect(wrapFunction(Base as unknown as () => void, ["Base"], s)).toBe(Base);
    expect(wrapFunction(Guarded as unknown as () => void, ["Guarded"], s)).toBe(Guarded);
    expect(s.skipped.get("Base")).toBe("class-or-constructor-function");
    expect(Guarded.next()).toBe(1);
  });

  it("never wraps functions with prototype methods (the pre-class style of class)", () => {
    const s = sink();
    function Legacy(this: object) {}
    Legacy.prototype.method = () => 1;
    expect(wrapFunction(Legacy as unknown as () => void, ["Legacy"], s)).toBe(Legacy);
    expect(s.skipped.get("Legacy")).toBe("class-or-constructor-function");
  });
});

describe("wrapModuleExports", () => {
  it("counts a function export as default and its function properties by name", () => {
    const s = sink();
    const render = Object.assign((x: string) => `r:${x}`, {
      helper: () => "h",
      VERSION: "1",
    });
    const wrapped = wrapModuleExports(render, s) as typeof render;
    expect(wrapped("a")).toBe("r:a");
    expect(wrapped.helper()).toBe("h");
    expect(wrapped.VERSION).toBe("1");
    expect(n(s, "default")).toBe(1);
    expect(n(s, "helper")).toBe(1);
    // The original function is not modified and still works.
    expect(render.helper()).toBe("h");
  });

  it("does not count inherited functions such as call and bind as exports", () => {
    const s = sink();
    const wrapped = wrapModuleExports(() => 1, s) as () => number;
    wrapped.bind(null)();
    expect([...s.counts.keys()]).toEqual(["default"]);
  });

  it("wraps function properties of a plain object without modifying the object", () => {
    const s = sink();
    const exports = {
      add: (a: number, b: number) => a + b,
      self(this: { add: (a: number, b: number) => number }) {
        return this.add(1, 2);
      },
      value: 42,
    };
    const original = exports.add;
    const wrapped = wrapModuleExports(exports, s) as typeof exports;
    expect(wrapped.add(1, 1)).toBe(2);
    expect(wrapped.self()).toBe(3);
    expect(wrapped.value).toBe(42);
    expect(exports.add).toBe(original);
    expect(n(s, "add")).toBe(2);
    expect(Object.keys(wrapped)).toEqual(["add", "self", "value"]);
    // Same wrapper each time, for the module and for its members.
    expect(wrapModuleExports(exports, s)).toBe(wrapped);
    expect(wrapped.add).toBe(wrapped.add);
  });

  it("returns frozen properties exactly as they are (a Proxy invariant) and reports them", () => {
    const s = sink();
    const frozen = Object.freeze({ fn: () => "f", n: 1 });
    const wrapped = wrapModuleExports(frozen, s) as typeof frozen;
    expect(wrapped.fn).toBe(frozen.fn);
    expect(wrapped.fn()).toBe("f");
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(s.skipped.get("fn")).toBe("frozen-export");
    expect(n(s, "fn")).toBeUndefined();
  });

  it("wraps a function returned by a getter, and leaves the getter in place", () => {
    const s = sink();
    let reads = 0;
    const exports = {
      get lazy() {
        reads++;
        return () => "lazy";
      },
    };
    const wrapped = wrapModuleExports(exports, s) as typeof exports;
    expect(wrapped.lazy()).toBe("lazy");
    expect(reads).toBe(1);
    expect(typeof Object.getOwnPropertyDescriptor(exports, "lazy")?.get).toBe("function");
  });

  it("leaves class exports and non-plain objects alone and reports why", () => {
    const s = sink();
    class Thing {
      id = 1;
    }
    expect(wrapModuleExports(Thing, s)).toBe(Thing);
    const map = new Map();
    expect(wrapModuleExports(map, s)).toBe(map);
    expect(wrapModuleExports(5, s)).toBe(5);
    expect(wrapModuleExports(null, s)).toBeNull();
    expect(s.skipped.get("default")).toBeDefined();
  });

  it("keeps instanceof working for instances of a plain-function export", () => {
    const s = sink();
    const exports = { make: () => new Date(0) };
    const wrapped = wrapModuleExports(exports, s) as typeof exports;
    expect(wrapped.make() instanceof Date).toBe(true);
  });
});
