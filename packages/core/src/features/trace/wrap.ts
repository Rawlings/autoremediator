/**
 * Wrapping of a package's exports so calls to them are counted, without changing what they do.
 *
 * Every wrapper is a Proxy that counts and then forwards with `Reflect`, passing `this`, arguments
 * and `new.target` through untouched. Shapes that cannot be wrapped without risk are left as they
 * are and reported through `skip`, so the trace says "not counted" rather than "not called".
 */

export interface Counter {
  n: number;
}

/** What the wrapper reports into. One per traced package. */
export interface WrapSink {
  /** The counter for an export name. Calling it also marks the name as counted. */
  counter(name: string): Counter;
  /** Record that an export name could not be counted, and why. */
  skip(name: string, reason: string): void;
}

type AnyFunction = (...args: unknown[]) => unknown;

const isFunction = (value: unknown): value is AnyFunction => typeof value === "function";

/**
 * Classes, and functions used as constructors (anything with methods on its prototype), are never
 * wrapped. A wrapper is a different object from the class, so `instance.constructor === Class`,
 * `Class === internalReference` and static private fields reached through `this` would all behave
 * differently. Skipping them keeps tracing from changing the program, at the cost of not counting
 * their construction.
 */
function isConstructorLike(fn: AnyFunction): boolean {
  try {
    if (Function.prototype.toString.call(fn).startsWith("class")) return true;
    const prototype = (fn as { prototype?: object }).prototype;
    return prototype !== undefined && prototype !== null && Reflect.ownKeys(prototype).length > 1;
  } catch {
    return true;
  }
}

interface Wrapped {
  proxy: AnyFunction;
  counters: Set<Counter>;
}

const wrappedFunctions = new WeakMap<object, Wrapped>();
const wrappedObjects = new WeakMap<object, unknown>();
const wrappers = new WeakSet<object>();

/**
 * Wrap a function or class so each call and construction increments the counters of `names`. With
 * `members`, function-valued own properties read from it (`express.Router`) come back as counting
 * wrappers too, without modifying the function. Returns it unchanged when it cannot be wrapped.
 */
export function wrapFunction<T extends AnyFunction>(
  fn: T,
  names: readonly string[],
  sink: WrapSink,
  members = false,
): T {
  if (wrappers.has(fn)) return fn;
  const existing = wrappedFunctions.get(fn);
  if (existing) {
    for (const name of names) existing.counters.add(sink.counter(name));
    return existing.proxy as T;
  }
  if (isConstructorLike(fn)) {
    for (const name of names) sink.skip(name, "class-or-constructor-function");
    return fn;
  }
  const counters = new Set(names.map((name) => sink.counter(name)));
  const noted = new Set<string>();
  const handler: ProxyHandler<T> = {
    apply(target, thisArg, args) {
      for (const counter of counters) counter.n++;
      return Reflect.apply(target, thisArg, args);
    },
    construct(target, args, newTarget) {
      for (const counter of counters) counter.n++;
      // Hand the original back as new.target when the proxy itself was constructed, so checks such
      // as `new.target === Base` and the prototype of the new object are exactly the unwrapped ones.
      return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
    },
  };
  if (members) {
    handler.get = (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof key !== "string" || key === "prototype" || !isFunction(value)) return value;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      // Inherited functions (Function.prototype.call and friends) are not exports.
      if (!descriptor) return value;
      if ("value" in descriptor && !descriptor.writable && !descriptor.configurable) {
        // A Proxy must return a non-writable, non-configurable property exactly as it is.
        if (!noted.has(key)) {
          noted.add(key);
          sink.skip(key, "frozen-export");
        }
        return value;
      }
      return wrapFunction(value, [key], sink);
    };
  }
  const proxy = new Proxy(fn, handler);
  wrappedFunctions.set(fn, { proxy, counters });
  wrappers.add(proxy);
  return proxy;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Wrap an exports object. Function-valued own properties come back as counting wrappers when read;
 * the object itself is never modified, so getter-based exports stay as they are. Own properties
 * that are neither writable nor configurable (a frozen object) must be returned exactly as they
 * are, so those are reported as not counted.
 */
function wrapObject<T extends object>(target: T, sink: WrapSink): T {
  const noted = new Set<string>();
  const proxy = new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof key !== "string" || !isFunction(value)) return value;
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return value;
      if ("value" in descriptor && !descriptor.writable && !descriptor.configurable) {
        if (!noted.has(key)) {
          noted.add(key);
          sink.skip(key, "frozen-export");
        }
        return value;
      }
      return wrapFunction(value, [key], sink);
    },
  });
  wrappers.add(proxy);
  return proxy;
}

/**
 * Wrap what a CommonJS module exported: a function or class (counted as `default`, with its own
 * function properties counted by name), or a plain object whose function properties are counted by
 * name. Anything else is returned unchanged and reported.
 */
export function wrapModuleExports(exported: unknown, sink: WrapSink): unknown {
  if (exported === null || (typeof exported !== "function" && typeof exported !== "object")) {
    sink.skip("default", "export-is-not-an-object-or-function");
    return exported;
  }
  if (wrappers.has(exported)) return exported;
  if (wrappedObjects.has(exported)) return wrappedObjects.get(exported);

  let result: unknown;
  if (isFunction(exported)) {
    result = wrapFunction(exported, ["default"], sink, true);
  } else if (isPlainObject(exported)) {
    result = wrapObject(exported, sink);
  } else {
    sink.skip("default", "export-is-not-a-plain-object");
    result = exported;
  }
  wrappedObjects.set(exported, result);
  return result;
}
