mod repo;

use crate::repo::Repo;

#[get("/health")]
pub fn health() -> String {
    let repo = Repo {};
    repo.update("u1");
    bus.publish("events");
    String::from("ok")
}

pub fn list_items() -> String {
    consumer.subscribe("events");
    String::from("DELETE FROM sessions")
}

pub fn main() {
    let app = Router::new().route("/items", get(list_items));
}
