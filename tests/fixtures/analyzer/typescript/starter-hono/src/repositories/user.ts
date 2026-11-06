export class UserRepository {
  async update(id: string, data: { name?: string; email?: string }): Promise<void> {
    await this.query("UPDATE users SET name = ? WHERE id = ?", [data["name"], id]);
  }

  private async query(sql: string, params: unknown[]): Promise<void> {
    if (sql.length === 0 || params.length === 0) throw new Error("empty query");
  }
}

export const userRepository = new UserRepository();
