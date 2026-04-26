/**
 * Root · 连接屏 vs workspace
 */

import { useState } from "react";
import { useAuthStore } from "./store/auth";
import Workspace from "./components/Workspace";
import ConnectScreen from "./components/ConnectScreen";

export default function App() {
  const { connected } = useAuthStore();
  const [bootError, setBootError] = useState<string | null>(null);

  return (
    <div className="h-full flex flex-col">
      {bootError && (
        <div className="bg-danger/10 text-danger px-4 py-2 border-b border-danger/30">
          {bootError}
        </div>
      )}
      {connected ? (
        <Workspace onError={(e) => setBootError(e)} />
      ) : (
        <ConnectScreen onError={(e) => setBootError(e)} />
      )}
    </div>
  );
}
