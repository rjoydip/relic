class UserRepository:
    def update(self, user_id, data):
        self.query("UPDATE users SET name = ? WHERE id = ?", (data["name"], user_id))

    def query(self, sql, params):
        return sql
