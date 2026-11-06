import { userRepository } from "../repositories/user";

export interface UserUpdate {
  name?: string;
  email?: string;
}

export class UserService {
  async updateUser(id: string, data: UserUpdate): Promise<void> {
    await userRepository.update(id, data);
  }
}

export const userService = new UserService();
