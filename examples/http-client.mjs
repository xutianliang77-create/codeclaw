const baseUrl = process.env.CODECLAW_BASE_URL ?? "http://127.0.0.1:3000";
const authToken = process.env.CODECLAW_GATEWAY_TOKEN;

function buildHeaders(extra = {}) {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...extra
  };
}

async function main() {
  const health = await fetch(`${baseUrl}/health`, {
    headers: buildHeaders()
  });
  console.log("health:", await health.json());

  const message = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify({
      input: "help",
      userId: "example-http-user"
    })
  });
  console.log("json response:", await message.json());

  const stream = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildHeaders({
      "content-type": "application/json",
      accept: "text/event-stream"
    }),
    body: JSON.stringify({
      input: "doctor",
      userId: "example-http-user",
      stream: true
    })
  });

  if (!stream.body) {
    throw new Error("missing response body");
  }

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  console.log("sse events:");
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      console.log(chunk);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
