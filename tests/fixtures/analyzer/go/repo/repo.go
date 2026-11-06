package service

type Repo struct {
    table string
}

func (r *Repo) Update(id string) string {
    return r.query("UPDATE users SET name = ? WHERE id = ?", id)
}

func (r *Repo) Query(sql string) string {
    return sql
}

func (r *Repo) query(sql string, args ...string) string {
    return sql
}
