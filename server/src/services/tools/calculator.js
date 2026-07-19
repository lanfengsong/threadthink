/* ============================================================
   ThreadThink Server — Tool: Calculator
   ============================================================ */

export var calculatorTool = {
  definition: {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行精确的数学计算。当需要进行算术运算、单位换算、或复杂计算时使用。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "2 + 3 * 4" 或 "sqrt(16)" 或 "sin(pi/2)"',
          },
        },
        required: ['expression'],
      },
    },
  },

  execute: async function (args) {
    var expr = args.expression;
    if (!expr) return { error: '缺少数学表达式' };

    // Security: only allow safe mathematical characters
    var safe = /^[\d\s+\-*/().%^!eEpi\s,Math.sqrtMath.sinMath.cosMath.tanMath.absMath.powMath.logMath.PIMath.E]+$/;
    if (!safe.test(expr) && !/^(sqrt|sin|cos|tan|abs|pow|log|cbrt|ceil|floor|round|exp)\(/.test(expr)) {
      return { error: '表达式包含不安全的字符。只允许数字、运算符和 Math.* 函数。' };
    }

    // Replace math function aliases
    var sanitized = expr
      .replace(/sqrt\(/g, 'Math.sqrt(')
      .replace(/sin\(/g, 'Math.sin(')
      .replace(/cos\(/g, 'Math.cos(')
      .replace(/tan\(/g, 'Math.tan(')
      .replace(/abs\(/g, 'Math.abs(')
      .replace(/pow\(/g, 'Math.pow(')
      .replace(/log\(/g, 'Math.log(')
      .replace(/cbrt\(/g, 'Math.cbrt(')
      .replace(/ceil\(/g, 'Math.ceil(')
      .replace(/floor\(/g, 'Math.floor(')
      .replace(/round\(/g, 'Math.round(')
      .replace(/exp\(/g, 'Math.exp(')
      .replace(/pi/gi, 'Math.PI')
      .replace(/e(?![xp\(])/gi, 'Math.E');

    try {
      var result = Function('"use strict"; return (' + sanitized + ')')();
      if (typeof result !== 'number' || isNaN(result) || !isFinite(result)) {
        return { error: '计算结果是 ' + result + '，请检查表达式。', expression: expr };
      }
      // Round to reasonable precision
      var rounded = Math.round(result * 1e10) / 1e10;
      return { expression: expr, result: rounded };
    } catch (e) {
      return { error: '计算错误: ' + e.message, expression: expr };
    }
  },
};
