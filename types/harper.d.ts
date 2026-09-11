// What Harper hands a component that this repo does not import.
//
// Two ambient globals and one untyped dependency. Declared rather than worked around, so `tsc --noEmit`
// checks the files that use them instead of skipping them: runtime/ is the half a customer runs, and under
// the tsconfig this replaced it was the one half nothing checked at all.

/**
 * Harper's compartment logger, present only inside a compartment. resources.js reads it with a `typeof`
 * guard for exactly that reason and hands it down; runtime/ normalises whatever arrives.
 */
// `var`, not `const`: a global `var` is a property of globalThis, which is both how a compartment hands
// these over and how a test puts a partial one in place to see what the guard does with it.
declare var logger: undefined | Record<string, (message: string) => void>;

/** Harper's Resource base class, present only inside a compartment. */
declare var Resource: undefined | (new () => object);

// The guard ships plain ESM with JSDoc and no emitted declarations, and it is read here through
// `maxNodeModuleJsDepth` in tsconfig.json rather than through a hand-written .d.ts. A .d.ts would be a
// second, drifting copy of a module this repo does not own; its own JSDoc is the one that ships with it.
