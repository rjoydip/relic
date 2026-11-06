package com.example;

public class UserRepository {
    public String update(String id) {
        return this.query("UPDATE users SET name = ?");
    }

    public String query(String sql) {
        return sql;
    }
}
