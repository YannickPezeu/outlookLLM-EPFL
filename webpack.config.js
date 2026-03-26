const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
require("dotenv").config();

module.exports = async (env, argv) => {
  const isDev = argv.mode === "development";
  const isGhPages = env && env.ghpages;

  // HTTPS certs for dev (Office add-ins require HTTPS)
  let serverOptions = {};
  if (isDev) {
    try {
      const devCerts = require("office-addin-dev-certs");
      serverOptions = {
        type: "https",
        options: await devCerts.getHttpsServerOptions(),
      };
    } catch {
      // Fallback: use webpack's built-in self-signed cert
      console.log("office-addin-dev-certs not available, using default self-signed cert");
      serverOptions = { type: "https" };
    }
  }

  const config = {
    entry: {
      taskpane: "./src/taskpane/index.tsx",
      test: "./src/test/index.tsx",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].bundle.js",
      clean: true,
      publicPath: isGhPages ? "/outlookLLM-EPFL/" : "/",
    },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader"],
        },
        {
          // react-markdown v10+ and dependencies are ESM-only
          test: /\.js$/,
          resolve: { fullySpecified: false },
          include: /node_modules/,
          type: "javascript/auto",
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./src/taskpane/taskpane.html",
        filename: "taskpane.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        template: "./src/test/test.html",
        filename: "test.html",
        chunks: ["test"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets", to: "assets", noErrorOnMissing: true },
          { from: "manifest.xml", to: "manifest.xml" },
        ],
      }),
      new webpack.DefinePlugin({
        "process.env.ENTRA_CLIENT_ID": JSON.stringify(process.env.ENTRA_CLIENT_ID || ""),
        "process.env.ENTRA_TENANT_ID": JSON.stringify(process.env.ENTRA_TENANT_ID || ""),
      }),
    ],
    devServer: {
      port: 3000,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      server: serverOptions,
    },
  };

  if (isDev) {
    config.devtool = "source-map";
  }

  return config;
};
