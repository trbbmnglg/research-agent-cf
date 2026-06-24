import { PROMPTS } from "./prompts";

export interface Profile {
  role: string;
  stack: string[];
  interests: string[];
  ignore: string[];
}

const p = PROMPTS.profile;
export const PROFILE: Profile = {
  role: p.role,
  stack: [...p.stack],
  interests: [...p.interests],
  ignore: [...p.ignore],
};
