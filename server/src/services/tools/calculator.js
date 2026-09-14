/* ============================================================
   ThreadThink Server — Tool: Calculator
   ============================================================ */

var FUNCTIONS = new Map([
  ['sqrt', Math.sqrt], ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan],
  ['abs', Math.abs], ['pow', Math.pow], ['log', Math.log], ['cbrt', Math.cbrt],
  ['ceil', Math.ceil], ['floor', Math.floor], ['round', Math.round], ['exp', Math.exp],
]);
var MAX_LENGTH = 1000;
var MAX_TOKENS = 256;
var MAX_NESTING = 32;

export var calculatorTool = {
  definition: {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行数学计算。当需要进行算术运算、单位换算、或复杂计算时使用。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "2 + 3 * 4"、"sqrt(16)"、"sin(pi/2)"。^ 和 ** 都表示右结合的乘方，-2^2 = -4；% 表示余数。使用浮点数，不进行额外舍入。',
          },
        },
        required: ['expression'],
      },
    },
  },

  execute: async function (args) {
    var expr = args && args.expression;
    if (typeof expr !== 'string' || !expr.trim()) return { error: '缺少数学表达式' };

    try {
      if (expr.length > MAX_LENGTH) throw new Error('表达式过长');
      var result = evaluate(tokenize(expr));
      // Preserve small and large finite values rather than rounding to ten
      // decimals (which loses tiny results and can overflow large results).
      return { expression: expr, result: result };
    } catch (e) {
      return { error: '计算错误: ' + e.message, expression: expr };
    }
  },
};

function finite(value) {
  if (!Number.isFinite(value)) throw new Error('计算结果不是有限数，请检查表达式');
  return value;
}

function tokenize(source) {
  var tokens = [];
  var i = 0;
  while (i < source.length) {
    var rest = source.slice(i);
    if (/^\s/.test(rest)) { i++; continue; }
    var match = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (match) {
      tokens.push(finite(Number(match[0])));
    } else {
      // Math names are single, whitelisted identifiers, never property access.
      match = rest.match(/^(?:Math\.)?[A-Za-z_][A-Za-z0-9_]*/i);
      if (match) {
        tokens.push(match[0].toLowerCase().replace(/^math\./, ''));
      } else {
        if (/^(?:\+\+|--)/.test(rest)) throw new Error('不允许自增或自减');
        match = rest.match(/^(?:\*\*|[+\-*/%^(),])/);
        if (!match) throw new Error('表达式包含不安全的字符');
        tokens.push(match[0] === '**' ? '^' : match[0]);
      }
    }
    i += match[0].length;
    if (tokens.length > MAX_TOKENS) throw new Error('表达式过于复杂');
  }
  return tokens;
}

function evaluate(tokens) {
  var index = 0;
  var depth = 0;

  function take(token) {
    if (tokens[index] !== token) throw new Error('表达式语法错误');
    index++;
  }

  function additive() {
    var value = multiplicative();
    while (tokens[index] === '+' || tokens[index] === '-') {
      var op = tokens[index++];
      var right = multiplicative();
      value = finite(op === '+' ? value + right : value - right);
    }
    return value;
  }

  function multiplicative() {
    var value = unary();
    while (tokens[index] === '*' || tokens[index] === '/' || tokens[index] === '%') {
      var op = tokens[index++];
      var right = unary();
      value = finite(op === '*' ? value * right : op === '/' ? value / right : value % right);
    }
    return value;
  }

  // Unary signs bind below power; the power's right operand may have a sign.
  // This also makes exponentiation right-associative: 2^3^2 = 2^(3^2).
  function unary() {
    if (++depth > MAX_NESTING) throw new Error('表达式嵌套过深');
    var value;
    if (tokens[index] === '+' || tokens[index] === '-') {
      var op = tokens[index++];
      value = unary();
      if (op === '-') value = -value;
    } else {
      value = primary();
      if (tokens[index] === '^') {
        index++;
        value = finite(Math.pow(value, unary()));
      }
    }
    depth--;
    return value;
  }

  function primary() {
    var token = tokens[index++];
    if (typeof token === 'number') return token;
    if (token === 'pi') return Math.PI;
    if (token === 'e') return Math.E;
    if (token === '(') {
      var value = additive();
      take(')');
      return value;
    }
    if (FUNCTIONS.has(token)) {
      var fn = FUNCTIONS.get(token);
      take('(');
      var args = [additive()];
      while (tokens[index] === ',') {
        index++;
        args.push(additive());
      }
      take(')');
      if (args.length !== fn.length) throw new Error('函数参数数量错误');
      return finite(fn.apply(null, args));
    }
    throw new Error('不允许的标识符或表达式语法错误');
  }

  var result = additive();
  if (index !== tokens.length) throw new Error('表达式语法错误');
  return finite(result);
}
