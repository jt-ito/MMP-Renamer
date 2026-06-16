module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        Set: "readonly",
        Map: "readonly",
        Promise: "readonly",
        URL: "readonly"
      }
    },
    rules: {
      "no-undef": "error"
    }
  }
];
