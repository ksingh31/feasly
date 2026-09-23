// Azure Functions v3 programming model (module.exports). No dependencies.
module.exports = async function (context, req) {
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: {
      status: "ok",
      service: "feasly-api",
      version: "0.1.0"
    }
  };
};
