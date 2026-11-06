package main

import (
    "fmt"
    "example/repo"
)

func GetUser(id string) string {
    store := repo.Repo{}
    store.Update(id)
    fmt.Println("SELECT * FROM audit_log")
    return id
}

func main() {
    r := NewRouter()
    GetUser("demo")
    r.GET("/users/:id", GetUser)
    r.POST("/users", CreateUser)
    bus.Publish("events", "created")
    bus.Subscribe("events")
    http.HandleFunc("/health", Health)
}

func CreateUser() {}

func Health() {}
