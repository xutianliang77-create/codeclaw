import { CodeClawSdkClient } from "../src/sdk/client";

async function main() {
  const client = new CodeClawSdkClient(
    process.env.CODECLAW_BASE_URL ?? "http://127.0.0.1:3000",
    process.env.CODECLAW_GATEWAY_TOKEN
  );

  console.log("health:", await client.healthCheck());

  const response = await client.sendMessage({
    input: "help",
    userId: "example-sdk-user"
  });
  console.log("json response:", response);

  console.log("stream response:");
  for await (const event of client.streamMessage({
    input: "doctor",
    userId: "example-sdk-user"
  })) {
    console.log(event);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
