import os
import anthropic

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

SYSTEM_PROMPT = """You are a helpful assistant for SipSam, a card game.
You can answer questions about the rules, help players strategize, and make the game more fun.
Keep your responses friendly, concise, and relevant to the card game context."""


def chat():
    """Run an interactive multi-turn chat session with Claude."""
    print("SipSam Card Game - Claude Chat Assistant")
    print("Type 'quit' or 'exit' to end the session.\n")

    messages = []

    while True:
        user_input = input("You: ").strip()

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit"):
            print("Goodbye!")
            break

        messages.append({"role": "user", "content": user_input})

        with client.messages.stream(
            model="claude-opus-4-6",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=messages,
            thinking={"type": "adaptive"},
        ) as stream:
            print("Claude: ", end="", flush=True)
            response = stream.get_final_message()

        assistant_text = next(
            (block.text for block in response.content if block.type == "text"), ""
        )
        print(assistant_text)
        print()

        messages.append({"role": "assistant", "content": assistant_text})


if __name__ == "__main__":
    chat()
