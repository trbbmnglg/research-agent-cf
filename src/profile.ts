// Your personal profile — the lens the agent scores every news item through
// ("why should I care?"). Edit freely.

export interface Profile {
  role: string;
  stack: string[];
  interests: string[];
  ignore: string[];
}

export const PROFILE: Profile = {
  role: "backend developer",
  stack: ["LangGraph", "Python", "FastAPI", "Postgres"],
  interests: ["agentic AI", "AI agents", "LLM orchestration", "AGI"],
  ignore: ["image generation", "AI art", "crypto"],
};
