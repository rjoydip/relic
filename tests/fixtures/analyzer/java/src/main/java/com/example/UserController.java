package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

public class UserController {
    private final UserService service;

    public UserController(UserService service) {
        this.service = service;
    }

    @GetMapping("/users/{id}")
    public String getUser(String id) {
        service.update(id);
        return id;
    }

    @PostMapping("/users")
    public String createUser(String id) {
        return service.update(id);
    }

    @RequestMapping("/legacy")
    public String legacy() {
        return "ok";
    }
}
