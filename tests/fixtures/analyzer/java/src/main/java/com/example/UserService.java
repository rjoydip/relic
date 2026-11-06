package com.example;

import com.example.UserRepository;

public class UserService {
    private UserRepository repo;

    public String update(String id) {
        this.repo.update(id);
        return id;
    }

    public String query() {
        return this.repo.query("SELECT * FROM users");
    }
}
