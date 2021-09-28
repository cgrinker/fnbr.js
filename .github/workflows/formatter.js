const path = require('path');

/**
 * Takes ESLint output and makes it GitHub-friendly
 * i.e. errors & warnings show up in GUIs
 */
module.exports = (results) => {
  for (const result of results) {
    for (const data of result.messages) {
      // Different parameters GitHub can show
      const severity = data.severity === 1 ? 'warning' : 'error';
      const file = path.relative(process.cwd(), result.filePath);
      const line = data.line;
      const col = data.column;
      const message = data.message;

      console.log(`::${severity} file=${file},line=${line},col=${col}::${message}`)
    }
  }
};
