import ChatView from "./chat-view";
import { listChatModels } from "@/lib/data/chat";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Infernet Chat — P2P inference playground",
  description:
    "Try Infernet Protocol's peer-to-peer AI network with CPU text-to-speech and speech recognition voice mode."
};

export default async function ChatPage() {
  let models = [];
  try {
    models = await listChatModels();
  } catch {
    models = [];
  }

  return (
    <>
      <ChatView initialModels={models} />
    </>
  );
}
