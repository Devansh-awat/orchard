type Token =
	| { kind: 'num'; value: number }
	| { kind: 'id'; name: string }
	| { kind: 'op'; op: string };

export type Calculation = {
	expression: string;
	value: number;
	formatted: string;
	copy: string;
};

const ALIASES: Record<string, string> = {
	'×': '*',
	'·': '*',
	'÷': '/',
	'−': '-',
	'–': '-'
};

const CONSTANTS: Record<string, number> = {
	pi: Math.PI,
	π: Math.PI,
	tau: Math.PI * 2,
	e: Math.E
};

const FUNCTIONS: Record<string, { min: number; max: number; run: (...a: number[]) => number }> = {
	sqrt: { min: 1, max: 1, run: (x) => Math.sqrt(x) },
	abs: { min: 1, max: 1, run: (x) => Math.abs(x) },
	floor: { min: 1, max: 1, run: (x) => Math.floor(x) },
	ceil: { min: 1, max: 1, run: (x) => Math.ceil(x) },
	round: {
		min: 1,
		max: 2,
		run: (x, digits = 0) => {
			const f = 10 ** Math.trunc(digits);
			return Math.round(x * f) / f;
		}
	},
	min: { min: 1, max: Infinity, run: (...a) => Math.min(...a) },
	max: { min: 1, max: Infinity, run: (...a) => Math.max(...a) },
	log: {
		min: 1,
		max: 2,
		run: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base))
	},
	ln: { min: 1, max: 1, run: (x) => Math.log(x) }
};

class Fail extends Error {}

function tokenize(source: string): Token[] {
	const out: Token[] = [];
	const s = source.replace(/\*\*/g, '^');
	let i = 0;
	while (i < s.length) {
		const c = ALIASES[s[i]] ?? s[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i));
		if (num) {
			out.push({ kind: 'num', value: parseFloat(num[0]) });
			i += num[0].length;
			continue;
		}
		const id = /^(?:[a-z]+|π)/i.exec(s.slice(i));
		if (id) {
			out.push({ kind: 'id', name: id[0].toLowerCase() });
			i += id[0].length;
			continue;
		}
		if ('+-*/^%(),'.includes(c)) {
			out.push({ kind: 'op', op: c });
			i++;
			continue;
		}
		throw new Fail();
	}
	return out;
}

function parse(tokens: Token[]) {
	let at = 0;
	let work = 0;

	const peek = (o = 0) => tokens[at + o];
	const isOp = (t: Token | undefined, op: string) => t?.kind === 'op' && t.op === op;
	const opens = (t: Token | undefined) =>
		!!t && (t.kind !== 'op' || t.op === '(' || t.op === '-' || t.op === '+');

	function expect(op: string) {
		if (!isOp(peek(), op)) throw new Fail();
		at++;
	}

	function expr(): number {
		let left = term();
		while (isOp(peek(), '+') || isOp(peek(), '-')) {
			const op = (tokens[at++] as { op: string }).op;
			const right = term();
			left = op === '+' ? left + right : left - right;
			work++;
		}
		return left;
	}

	function term(): number {
		let left = unary();
		for (;;) {
			const t = peek();
			if (isOp(t, '*') || isOp(t, '/') || isOp(t, '%')) {
				at++;
				const right = unary();
				const op = (t as { op: string }).op;
				left = op === '*' ? left * right : op === '/' ? left / right : left % right;
				work++;
			} else if (t && (t.kind === 'id' || isOp(t, '('))) {
				left = left * power();
				work++;
			} else return left;
		}
	}

	function unary(): number {
		if (isOp(peek(), '-')) {
			at++;
			return -unary();
		}
		if (isOp(peek(), '+')) {
			at++;
			return unary();
		}
		return postfix();
	}

	function postfix(): number {
		let value = power();
		while (isOp(peek(), '%') && !opens(peek(1))) {
			at++;
			value /= 100;
			work++;
		}
		return value;
	}

	function power(): number {
		const base = primary();
		if (!isOp(peek(), '^')) return base;
		at++;
		work++;
		return base ** unary();
	}

	function primary(): number {
		const t = peek();
		if (!t) throw new Fail();
		if (t.kind === 'num') {
			at++;
			return t.value;
		}
		if (t.kind === 'id') {
			at++;
			const fn = Object.hasOwn(FUNCTIONS, t.name) ? FUNCTIONS[t.name] : undefined;
			if (fn) {
				expect('(');
				const args = [expr()];
				while (isOp(peek(), ',')) {
					at++;
					args.push(expr());
				}
				expect(')');
				if (args.length < fn.min || args.length > fn.max) throw new Fail();
				work++;
				return fn.run(...args);
			}
			if (Object.hasOwn(CONSTANTS, t.name)) return CONSTANTS[t.name];
			throw new Fail();
		}
		if (t.op === '(') {
			at++;
			const value = expr();
			expect(')');
			return value;
		}
		throw new Fail();
	}

	const value = expr();
	if (at !== tokens.length) throw new Fail();
	return { value, work };
}

export function evaluate(input: string): { value: number; work: number } | null {
	const source = input.trim().replace(/=+$/, '').trim();
	if (!source) return null;
	try {
		const tokens = tokenize(source);
		if (!tokens.length) return null;
		const result = parse(tokens);
		return Number.isFinite(result.value) ? result : null;
	} catch (err) {
		if (err instanceof Fail) return null;
		throw err;
	}
}

export function tidy(n: number): number {
	const v = Number(n.toPrecision(12));
	return Object.is(v, -0) ? 0 : v;
}

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 10 });

export function formatNumber(n: number): string {
	const v = tidy(n);
	const abs = Math.abs(v);
	if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) {
		return v
			.toExponential(6)
			.replace(/\.?0+e/, 'e')
			.replace('e+', 'e');
	}
	return GROUPED.format(v);
}

export function calculate(input: string): Calculation | null {
	const result = evaluate(input);
	if (!result || result.work === 0) return null;
	return {
		expression: input.trim().replace(/=+$/, '').trim(),
		value: result.value,
		formatted: formatNumber(result.value),
		copy: String(tidy(result.value))
	};
}
