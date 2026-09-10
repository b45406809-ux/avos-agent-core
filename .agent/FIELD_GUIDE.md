
```markdown
# 🧭 SWARM FIELD GUIDE: SQLite Compatible Engine (Rust Implementation)
**Architecture Standard, Binary Format Invariants, Trait Contracts & Conformance Ledger**

> **NOTICE FOR ALL AGENTS IN THE SWARM:**
> 1. **Read-Before-Write Invariant:** You must read the relevant sections of this document before creating or modifying any code.
> 2. **Stigmergic Rule:** If you introduce a public struct, trait implementation, or binary constant, you must append it to **Section 3 (Registered Contracts)** before invoking `finish_goal`.
> 3. **Non-Regression Policy:** Code is only committed if it passes the exact test command assigned in your task DAG. Never disable tests to force a pass.

---

## 1. System Architecture & Layer Hierarchy

The engine is strictly partitioned into six decoupled layers. **Lower layers MUST NOT depend on higher layers.**

```
┌────────────────────────────────────────────────────────┐
│  Layer 5: SQL Frontend (Lexer, Parser, AST, Planner)   │  src/sql/
└───────────────────────────┬────────────────────────────┘
                            │ Emits VDBE Bytecode
┌───────────────────────────▼────────────────────────────┐
│  Layer 4: VDBE (Virtual Database Engine)               │  src/vdbe/
└───────────────────────────┬────────────────────────────┘
                            │ Invokes Cursors & Table Scans
┌───────────────────────────▼────────────────────────────┐
│  Layer 3: Record Decoder & Serializer (Varints/Types)  │  src/record/
└───────────────────────────┬────────────────────────────┘
                            │ Cell Payloads
┌───────────────────────────▼────────────────────────────┐
│  Layer 2: B-Tree Subsystem (Interior/Leaf Pages)       │  src/btree/
└───────────────────────────┬────────────────────────────┘
                            │ Raw 4KB Page Reads/Writes
┌───────────────────────────▼────────────────────────────┐
│  Layer 1: Pager & Cache Pool (ACID, Locks, WAL)        │  src/pager/
└───────────────────────────┬────────────────────────────┘
                            │ File I/O
┌───────────────────────────▼────────────────────────────┐
│  Layer 0: VFS (Virtual File System / OS Abstraction)   │  src/vfs/
└────────────────────────────────────────────────────────┘
```

---

## 2. Binary Invariants & Wire Format Specifications

All disk formats must match the official **SQLite 3.X Database File Format** byte-for-byte.

### 2.1 The 100-Byte Database Header (Page 1)

Every database file begins with exactly 100 bytes of metadata located at offset `0x00`:

| Byte Offset | Size (Bytes) | Type | Value / Description |
| :--- | :--- | :--- | :--- |
| `0..16` | 16 | String | Constant: `"SQLite format 3\000"` (ASCII + null) |
| `16..18` | 2 | Big-Endian u16 | Page size in bytes (`512` to `65536`, must be a power of 2; `1` represents 65536) |
| `18` | 1 | u8 | File format write version: `1` (legacy rollback journal), `2` (WAL) |
| `19` | 1 | u8 | File format read version: `1` (legacy rollback journal), `2` (WAL) |
| `20` | 1 | u8 | Reserved bytes at the end of each page (usually `0`) |
| `21` | 1 | u8 | Maximum embedded payload fraction (must be `64`) |
| `22` | 1 | u8 | Minimum embedded payload fraction (must be `32`) |
| `23` | 1 | u8 | Leaf payload fraction (must be `32`) |
| `24..28` | 4 | Big-Endian u32 | File change counter (incremented on every write) |
| `28..32` | 4 | Big-Endian u32 | Size of the database file in pages (valid when change counter matches) |
| `32..36` | 4 | Big-Endian u32 | Page number of the first freelist trunk page |
| `36..40` | 4 | Big-Endian u32 | Total number of freelist pages |
| `40..44` | 4 | Big-Endian u32 | Schema cookie (incremented on DDL schema changes) |
| `44..48` | 4 | Big-Endian u32 | Schema format number (`1`, `2`, `3`, or `4`) |
| `48..52` | 4 | Big-Endian u32 | Default page cache size |
| `52..56` | 4 | Big-Endian u32 | Page number of the largest root b-tree page (in auto-vacuum mode) |
| `56..60` | 4 | Big-Endian u32 | Text encoding: `1` (UTF-8), `2` (UTF-16le), `3` (UTF-16be) |
| `60..64` | 4 | Big-Endian u32 | User version |
| `64..68` | 4 | Big-Endian u32 | Incremental-vacuum mode flag (`0` or `1`) |
| `68..72` | 4 | Big-Endian u32 | Application ID |
| `72..92` | 20 | Bytes | Reserved for expansion (must be zeroed) |
| `92..96` | 4 | Big-Endian u32 | Version-valid-for number |
| `96..100` | 4 | Big-Endian u32 | SQLite library version number |

---

### 2.2 Variable-Length Integers (Varints)

SQLite uses variable-length integers (1 to 9 bytes) to encode 64-bit signed/unsigned values.

* **Bytes 1 to 8:** The most significant bit (MSB, `0x80`) is a continuation bit. If `0`, this is the final byte; if `1`, read the next byte. The lower 7 bits contain payload data.
* **Byte 9 (Optional):** All 8 bits are used directly as data (no continuation bit).

```rust
// Standard implementation required in src/record/varint.rs
pub fn read_varint(buffer: &[u8]) -> Result<(u64, usize), VarintError> {
    let mut result: u64 = 0;
    for i in 0..8 {
        if i >= buffer.len() { return Err(VarintError::UnexpectedEof); }
        let byte = buffer[i];
        result = (result << 7) | ((byte & 0x7F) as u64);
        if (byte & 0x80) == 0 {
            return Ok((result, i + 1));
        }
    }
    if buffer.len() < 9 { return Err(VarintError::UnexpectedEof); }
    result = (result << 8) | (buffer[8] as u64);
    Ok((result, 9))
}
```

---

### 2.3 B-Tree Page Types and Page Headers

Every page in a B-Tree begins with a Page Header (offset `0` for pages `> 1`; offset `100` for Page 1):

* **`0x02`**: Interior Index B-Tree Page (contains child page pointers and key payloads).
* **`0x05`**: Interior Table B-Tree Page (contains child page pointers and 64-bit integer rowids).
* **`0x0A`**: Leaf Index B-Tree Page (contains key payloads and rowid references).
* **`0x0D`**: Leaf Table B-Tree Page (contains variable payloads, schemas, and table records).

#### B-Tree Page Header Layout:
1. `0..1` (`u8`): Page Type (`0x02`, `0x05`, `0x0A`, `0x0D`).
2. `1..3` (`u16` BE): Start of the first freeblock on this page (or `0` if none).
3. `3..5` (`u16` BE): Number of cells on this page.
4. `5..7` (`u16` BE): Byte offset to the start of the cell content area (`0` means 65536).
5. `7` (`u8`): Number of fragmented free bytes within the cell content area.
6. `8..12` (`u32` BE, **Interior pages only**): Right-most child page number.

Following the header is the **Cell Pointer Array**: a contiguous list of 2-byte unsigned integers (big-endian) representing offsets into the page where each cell's data begins.

---

### 2.4 Record Format (Payload Encoding)

Rows inside Leaf Table B-Trees are stored as binary records:
1. **Header Size (Varint):** Total byte length of the record header (including this varint).
2. **Serial Type Array (Varints):** One varint per column, indicating the data type and length.
3. **Data Segment:** Contiguous byte sequence of actual column values without padding.

#### Serial Type Encoding Table:
| Serial Type | Content Size | Type Interpretation |
| :--- | :--- | :--- |
| `0` | 0 bytes | `NULL` |
| `1` | 1 byte | 8-bit two's complement integer |
| `2` | 2 bytes | 16-bit big-endian integer |
| `3` | 3 bytes | 24-bit big-endian integer |
| `4` | 4 bytes | 32-bit big-endian integer |
| `5` | 6 bytes | 48-bit big-endian integer |
| `6` | 8 bytes | 64-bit big-endian integer |
| `7` | 8 bytes | IEEE 754-2008 64-bit floating point |
| `8` | 0 bytes | Integer constant `0` (boolean false) |
| `9` | 0 bytes | Integer constant `1` (boolean true) |
| `10, 11` | N/A | Reserved for internal use |
| `N >= 12 && even`| `(N - 12) / 2` bytes | `BLOB` |
| `N >= 13 && odd` | `(N - 13) / 2` bytes | `TEXT` (UTF-8 encoded string) |

---

## 3. Registered Rust Trait Contracts (Interfaces)

All modules must implement and consume these shared trait interfaces to prevent integration bottlenecks across worker branches.

### 3.1 VFS (Virtual File System)
```rust
// File: src/vfs/mod.rs
pub trait Vfs: Send + Sync {
    type File: FileHandle;
    fn open(&self, path: &str, flags: OpenFlags) -> Result<Self::File, VfsError>;
    fn delete(&self, path: &str) -> Result<(), VfsError>;
    fn exists(&self, path: &str) -> Result<bool, VfsError>;
}

pub trait FileHandle: Send + Sync {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> Result<(), VfsError>;
    fn write_all_at(&mut self, buf: &[u8], offset: u64) -> Result<(), VfsError>;
    fn sync(&mut self) -> Result<(), VfsError>;
    fn size(&self) -> Result<u64, VfsError>;
}
```

### 3.2 Pager Layer
```rust
// File: src/pager/mod.rs
pub type PageId = u32;

pub trait Pager: Send + Sync {
    fn get_page(&mut self, page_id: PageId) -> Result<&[u8], PagerError>;
    fn get_page_mut(&mut self, page_id: PageId) -> Result<&mut [u8], PagerError>;
    fn allocate_page(&mut self) -> Result<PageId, PagerError>;
    fn begin_transaction(&mut self) -> Result<(), PagerError>;
    fn commit_transaction(&mut self) -> Result<(), PagerError>;
    fn rollback_transaction(&mut self) -> Result<(), PagerError>;
    fn page_size(&self) -> usize;
}
```

### 3.3 B-Tree Subsystem
```rust
// File: src/btree/mod.rs
pub trait BTreeEngine {
    type Cursor: BTreeCursor;
    fn open_table(&mut self, root_page: PageId) -> Result<Self::Cursor, BTreeError>;
    fn create_table(&mut self) -> Result<PageId, BTreeError>;
    fn insert(&mut self, root_page: PageId, rowid: i64, payload: &[u8]) -> Result<(), BTreeError>;
    fn delete(&mut self, root_page: PageId, rowid: i64) -> Result<bool, BTreeError>;
}

pub trait BTreeCursor {
    fn seek(&mut self, key: i64) -> Result<bool, BTreeError>;
    fn first(&mut self) -> Result<bool, BTreeError>;
    fn next(&mut self) -> Result<bool, BTreeError>;
    fn current_rowid(&self) -> Result<i64, BTreeError>;
    fn current_payload(&self) -> Result<Vec<u8>, BTreeError>;
}
```

### 3.4 VDBE (Virtual Database Engine)
```rust
// File: src/vdbe/mod.rs
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(Debug, Clone)]
pub enum Opcode {
    Init { target_pc: usize },
    OpenRead { cursor: usize, root_page: u32 },
    OpenWrite { cursor: usize, root_page: u32 },
    Rewind { cursor: usize, on_empty_pc: usize },
    Next { cursor: usize, on_valid_pc: usize },
    Column { cursor: usize, column_idx: usize, dest_reg: usize },
    MakeRecord { start_reg: usize, count: usize, dest_reg: usize },
    Insert { cursor: usize, record_reg: usize, key_reg: usize },
    ResultRow { start_reg: usize, count: usize },
    Halt,
}

pub trait Vdbe {
    fn execute(&mut self, program: &[Opcode]) -> Result<Vec<Vec<Value>>, VdbeError>;
}
```

---

## 4. Conformance Oracle & Test Harness

A worker's pull request is verified exclusively against deterministic oracles.

### 4.1 Tier-1 Unit Testing (Fast Local Self-Healing)
Every leaf worker must pass its local module test before submitting work:
* `cargo test -p engine-vfs`
* `cargo test -p engine-record`
* `cargo test -p engine-pager`
* `cargo test -p engine-btree`
* `cargo test -p engine-vdbe`

### 4.2 Tier-2 Integration Testing (End-to-End SQL Logic)
The entire test suite is executed by the **Referee Agent** using `sqllogictest-rs`:
```bash
cargo test --test sqllogictest_suite
```
All queries inside `harness/sqllogictest/test/select1.test` and `harness/sqllogictest/test/insert.test` must match the expected output hash.

---

## 5. Swarm Operational Rules (Rules of Engagement)

1. **Strict File Scoping:**
   * Workers assigned to `Layer 1 (Pager)` must never edit files in `src/sql/` or `src/vdbe/`.
   * Cross-layer modifications require an RFC entry appended to this Field Guide by the Planner.
2. **Worktree Hygiene:**
   * Run all commands within your designated `.worktrees/<task_id>` directory.
   * Do not commit compiled binaries, `.swp` files, or artifacts (`target/`).
3. **AST Merging Protocol:**
   * If `git merge` reports a conflict, the Referee parses both trees using Tree-Sitter (`engine/indexer.mjs`). Overlapping function bodies will cause an automatic roll back; separate functions in the same file will be stitched together automatically.

---

## 6. Swarm Task Graph & Execution Ledger

*(Updated dynamically by the Planner and Referee agents)*

| Task ID | Module / Layer | Description | Dependencies | Verification Oracle | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `TASK-01` | `src/vfs` | POSIX file handle & synchronous pwrite/pread engine | None | `cargo test test_vfs` | ✅ COMPLETED |
| `TASK-02` | `src/record` | Varint encoding & serial-type payload decoding | None | `cargo test test_varint` | ✅ COMPLETED |
| `TASK-03` | `src/pager` | 4KB Buffer pool, cache eviction, and header reader | `TASK-01` | `cargo test test_pager` | 🔄 IN PROGRESS |
| `TASK-04` | `src/btree` | Table Leaf (0x0D) cell parser and pointer array reader | `TASK-02`, `TASK-03` | `cargo test test_btree_leaf` | ⏳ PENDING |
| `TASK-05` | `src/btree` | Interior Table (0x05) traversal & child search | `TASK-04` | `cargo test test_btree_seek` | ⏳ PENDING |
| `TASK-06` | `src/vdbe` | Register allocation & cursor iteration opcodes | `TASK-04` | `cargo test test_vdbe_scan` | ⏳ PENDING |
| `TASK-07` | `src/sql` | Tokenizer & Recursive Descent Parser for SELECT | None | `cargo test test_sql_parser` | ⏳ PENDING |
| `TASK-08` | `src/sql` | Query Planner: Ast-to-VDBE opcode compiler | `TASK-06`, `TASK-07` | `cargo test test_sql_compiler` | ⏳ PENDING |
| `TASK-09` | `harness` | End-to-end `sqllogictest` verification runner | `TASK-08` | `cargo run --bin sqllogictest` | ⏳ PENDING |
```
