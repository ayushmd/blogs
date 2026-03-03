---
title: "Building a Persistent TTL-Based Queue along with embedded database"
date: "2025-02-25"
description: "A durable, time-based event queue built from scratch with Go, PebbleDB, and gRPC — designed for reliability beyond in-memory timers."
tags: ["go", "queue", "distributed", "rocksdb", "from scratch", "embedded db", "system design", "grpc"]
github: "https://github.com/ayushmd/cue"
---

![alt text](/blogs/images/create-your-own-queue/gopher_alarm.png)

While working on a side project i needed a service which would trigger and return the event at required timestamp or after specified time(seconds, hours or perhaps days) like a alarm clock. Well could have got away with something like 

```
setTimeout(func,1000)
```

But it would be on RAM and in case of crash there would be no persistence for such events. Also in case of multiple such triggers from different locations in code it would create additional management and less control over these events. It would be much efficient to create a single component that would manage everything and sit as service something similar to redis or rabbitmq.

Which brought me to the thought, There have been many queues which hold data in distributed systems but notification/scheduling system has always been a glue of queue's, database with a timestamp and controllers running in background for notification. So why not create service which does it all.

Initialy started by creating a service which runs on memory with powerful concurrency of Go along with Min Heap to do priority scheduling based on ttl. Which had a pretty simple implementation and worked perfectly but it does not guarantee persistence, which is not suitable for something like scheduling a email notification to a user after 2 days. 

```go
func (q *TTLQueue) Push(data any, priority int64) {
	// append the element to the store
	el := &element{
		priority: priority,
		data:     data,
		index:    q.store.Len(),
	}
	q.mux.Lock()
	defer q.mux.Unlock()
	heap.Push(&q.store, el)
	// fix the store order
	heap.Fix(&q.store, el.index)
}

func (q *TTLQueue) Pop() any {
	q.mux.Lock()
	defer q.mux.Unlock()
	if q.store.Len() == 0 {
		return nil
	}

	el := heap.Pop(&q.store)
	if el == nil {
		return nil
	}

	return el.(*element).data
}

type TTLItem struct {
	id        int
	createdAt int64
}

func main() {
	ttlq := NewTTLQueue()

	// Background queue listner
	go func() {
		for {
			select {
			case job := <-ttlq.Subscribe():
				jobj := job.(*TTLItem)
				fmt.Printf(
					"Recieved Job %d: Created At: %d Recieved At: %d\n", 
					jobj.id, jobj.createdAt, time.Now().Unix()
				)
			}
		}
	}()

	ttlq.Push(&TTLItem{
		id:        1,
		createdAt: time.Now().Unix(),
	}, time.Now().Add(10*time.Second).Unix())
}
```
To create a stable tool we need to first decide what to build on

## What and why to choose?

### Storage Layer

To provide persistence it would require a database or perhaps a storage engine where the events can be stored and pooled frequently. What better than storage engines like RocksDB or SQLite these are lower levels of storage units which given abstractions over os level storage. RocksDB(https://rocksdb.org/) is one such embedded db which has been battle tested in MyRocks(MySQL on rocksdb), TikV, Kafka migrating to rocksdb for storage engine and also Apache Flink in big data processing. 

Such db makes a perfect case for persistence and high availability with little overhead compared to a full blown client-server database. Below is a short explaination of how LSM Based RocksDB and embeddeddb's works.

**Embedded DB**

An embedded database is a database that runs inside your application process as a library rather than as a separate server. In LSM-tree–based embedded databases such as RocksDB, data is first written to an in-memory structure called a `MemTable`. The MemTable is typically a sorted data structure (like a skip list or balanced tree) that keeps recent writes in RAM for very fast insert performance. When a write comes in, it is appended to a write-ahead log (WAL) for durability, and then inserted into the MemTable. Reads first check the MemTable because it contains the newest data. Once the MemTable reaches a size limit, it is flushed to disk as an immutable file called an SSTable.


An `SSTable` (Sorted String Table) is a persistent, immutable, sorted file stored on disk. It contains key-value pairs sorted by key, which allows efficient lookups via binary search and indexing structures like Bloom filters. Because SSTables are immutable, updates do not modify existing files. Instead, new data is written to new SSTables, and background processes called compactions merge multiple SSTables together to remove deleted or overwritten entries and maintain read efficiency. This design trades slightly more complex reads (since data may exist in multiple levels) for extremely fast sequential writes and good crash safety.

![alt text](/blogs/images/create-your-own-queue/lsm_architecture.jpg)
*Img 1: LSM architecture Source: https://vivekbansal.substack.com/p/what-is-lsm-tree*

You can read more about LSM Tree's in the paper (https://www.cs.umb.edu/~poneil/lsmtree.pdf)

I chose Go to create this service as it is my goto language and RocksDB is written in C++, though there are direct bindings for C++ functions in Go there are some inconsistensies while using FFI. There are many well known KV Stores in native Go Implementation like BadgerDB(used by jaeger), BoltDB/BBolt(used by etcd), etcd, PebbleDB. So after researching for sometime i decided to use PebbledDB which is a RocksDB inspired key-value store written in go. It is open-source and has support for distributed systems used by and built by CockroachDB.  

Here LSM tree KV comes in handy for the current use case because it has levels of storage, Initially it stores the message on RAM(Memtable) and flushes it to disk(SSTables) eventually so event with small ttl will give fast lookups.


### Server Layer

To create a cohesive system we would require a server and client with a protocol, and from design perspective will it be a Queue with long running connections or a webhook. I decided to keep it persistent connections with a server protocol as **HTTP2** which supports multiplexing and long running connections with server push instead of building one from scratch. During implementation it was apparent that there are inconsistent abstractions and lack of standardization between different languages, primarly go and js/ts(which was used at the time), So grpc streams proved to be best suited as it is built on **HTTP2** and has standardized support across different langugaes.

## Implementation

![alt text](/blogs/images/create-your-own-queue/scheduler_diagram.png)
*Img 2: Implementation architecture*

The flow starts by sending a event or a message which consists of QueueName, user data as Message and TTL a timestamp in Milliseconds. As discussed the data is exchanged via GRPC Streams.

As it is in key value store the data is stored in the format of 
```
'category_key:ttl:message_identifier': 'encoded_data'

Key = 'category_key:ttl:message_identifier'
Value = 'encoded_data'
```

The design choice for the key format is as because it makes it faster and efficient for lookups and range scans, how??.LSM stores kv in lexicographically sorted order, so *category_key* is to partition different types of storage units, *ttl* is for prefix matching lookups and a *message_identifier* which is the timestamp in millisecond when the message is received to avoid collision, message ordering and cleanups.

The message storage units are `'items:'`, `'zombie:'`, `'dead:'` & `'ack:'`. 

`'items:'` is for when the message is recieved initially, `'zombie:'` is for when the data is sent to client but not ACK'ed yet for retry mechanism, `'dead:'` is for DLQ (dead letter queue) implementation and prone to cleanup after a timeout provided and `'ack:'` is intermediate temporary lookup for ack recieved from client.


The value *encoded_data* is stored as encoded binary format. The value *encoded_data* includes the data inputs required for application level processing at queue, it consists of attibutes given below

```go
type Item struct {
	Id        int64  `json:"id"`
	QueueName string `json:"queueName"`
	Data      []byte `json:"data"`
	TTL       int64  `json:"ttl"`
	Retries   uint8  `json:"retries"`
}
```


for example 
```
{
	"queueName": "eventlog",
	"data":"{'msg':'first message but higher ttl'}",
	"ttl" : 1748122974,
}
{
	"queueName": "eventlog",
	"data":"{'msg':'second message but lower ttl'}",
	"ttl" : 1748122874,
}
```
will be stored as in given order,

|Key|Values|
|---|------|
|items:1748122874:1748122474	|encode(1748122474, "eventlog", {'msg':'second message but lower ttl'}, 1748122874, 3)|
|items:1748122974:1748122470	|encode(1748122470, "eventlog", {'msg':'first message but higher ttl'}, 1748122974, 3)|

Other Entries are stored in similar pattern. Also Every step is stored in db to provide persistence.


Items are pooled every `n` (eg: 500ms) and ttl difference with `k` (eg: 9-10s) are pushed to priority queue or min-heap which stores it on the ram and also store it with a zombie prefix, zombiefied items are the once which have been sent to client but not acked, it is to provide retry mechanism. if initial item is received with a ttl difference less than `k` it is directly pushed to Priority Queue and zombified which makes it tuned for quick ttl events. Dead items are the once which have been retried and haven't been acked this is for DLQ Implementation, they will be cleaned after a given time provided in config. The Dead letter queue(DLQ) is for when the message is not consumed even after retries or timeouts, which can be consumed when client reconnects.

The behaviour can be tweaked by changing the configs from `config.yaml`
```yaml
# The threshold of ttl when message is loaded on Priority Queue
# Message is loaded on memory (dosent mean it will be gone on switch off)
priority_time: 9000 # in ms (default 9 seconds)

# The number of retries to send to zombified
max_retries: 2

# The time after which the retry is performed (in seconds)
retry_timeout: 10

# Whether to read timed out items after connecting (this will not keep the data after consumption)
consume_expired: true

# Cleanup timeout for items consumed
cleanup_timeout: 86400000 # in ms (default 24 hours)

# Server port
port: 6336
```

There are multiple Pollers running in the background with intervals as provided either through configs or default requirements. There is backoff to db poller to avoid thrashing of db.
```go
func (m *Scheduler) Poll() {
	go m.poolItems()
	go m.poolZombie()
	go m.poolPriorityQueue()
	go m.poolInstantSender()
	go m.poolJanitor()
}
```

The DB Poolers are guarded by CompareAndSwap (CAS) it is done to avoid race condition and Compare and swap provides a fast way of locking and checking if the db is being used for a particular partition.

```go
type DataStorage struct {
	db    *pebble.DB
	flag  int32
	zflag int32
}

func (ds *DataStorage) TryLock() bool {
	return atomic.CompareAndSwapInt32(&ds.flag, 0, 1)
}

func (ds *DataStorage) Unlock() {
	atomic.StoreInt32(&ds.flag, 0)
}
```

The Inserts and Deletions done during state transition like 'item' transitioning to 'zombie' is done with batching. Pebble supports batch operations which are atomic by nature and ensure persistence even in state transitions.

Below is a snippet of how retry logic is implemented which indicates the batch usage
```go
func (s *Scheduler) Retry(b *pebble.Batch, acked bool, item Item) {
	s.ds.BatchDeleteZombieItem(b, item)
	if acked || item.Retries <= 0 {
		if cfg.ReadTimedOutAfterConnecting {
			if !acked {
				s.ds.BatchCreateDeadItem(b, item)
			}
		} else {
			s.ds.BatchCreateDeadItem(b, item)
		}
	} else {
		(&item).TTL = time.Now().Add(time.Duration(cfg.RetryAfterTimeout) * time.Second).UnixMilli()
		s.ds.BatchCreateZombieItem(b, item)
	}
}
```

When the message is ready to consume after the ttl, router sends the event to client through streams back again. There is also regex wildcard matching to push items to multiple queues at once. Scheduler server provides CRUD for queues and message/items via grpc. A cue client can be created for any language with the help of rpc contract named `rpc.proto` also available in repo

```proto
syntax = "proto3";

option go_package = "github.com/ayushmd/cue/rpc";

service SchedulerService {
    rpc Ping(Empty) returns (Response);
    rpc Listen (QueueNameRequest) returns (stream ItemResponse);
    rpc PushItem (ItemRequest) returns (Response);
    rpc Ack (AckRequest) returns (Response);
    rpc CreateQueue (QueueNameRequest) returns (Response);
    rpc ListQueues (Empty) returns (ListQueueResponse);
    rpc DeleteQueue (QueueNameRequest) returns (Response);
}

message Empty {}

message QueueNameRequest {
    string QueueName = 1;
}

message AckRequest {
    int64 Id = 1;
}

message Response {
    bool Success = 1;
}

message ListQueueResponse {
    repeated string Data = 1;
    bool Success = 2;
}

message ItemRequest {
    string QueueName = 1;
    bytes Data = 2;
    int64 Ttl = 3;
}

message ItemResponse {
    int64 id = 1;
    bytes Data = 2; 
    bool Ack = 3;
    bool success = 4;
}
```

Go Cobra is used to provide cli command execution. Also js client sdk and go client sdk is made with grpc.

### Steps to Try

The steps are provided in the github repo as well at: https://github.com/ayushmd/cue

Use prebuilt docker for quick start
```bash
docker pull cuekit/cue-server:v1.1
docker run --name cue-server -d -p 6336:6336 cuekit/cue-server:v1.1
```

Using Cue with Go Cue-Client
```bash
go get github.com/ayushmd/cue@latest
```
Listen to queue with 
```go
package main

import (
	"fmt"
	"log"
	"time"

	"github.com/ayushmd/cue/pkg/cuecl"
)

func main() {
	cli, err := cuecl.NewCueClient(":6336")
	if err != nil {
		log.Fatal("Failed to connect to server")
	}
	defer cli.Close()

	var queueName string = "test"

	err = cli.CreateQueue(queueName)
	if err != nil {
		log.Fatal("Failed to create queue")
	}

	ch, err := cli.Listen(queueName)
	if err != nil {
		log.Fatal("Failed to create Listen")
	}

	for data := range ch {
		fmt.Println("Recieved: ", string(data), time.Now().UnixMilli())
	}
}
```

Adding a item to queue

```go
package main

import (
	"fmt"
	"time"
	"log"

	"github.com/ayushmd/cue/pkg/cuecl"
)

func main() {
	cli, err := cuecl.NewCueClient(":6336")
	if err != nil {
		log.Fatal("Failed to connect to server")
	}
	defer cli.Close()

	ttl := time.Now().Add(10 * time.Second).UnixMilli()

	message := []byte(fmt.Sprintf("{'data':'test data', 'createdAt': '%d'}", time.Now().UnixMilli()))

	queueName := "test"

	err = cli.PushItem(queueName, message, ttl)
	if err != nil {
		fmt.Println("Failed to create item ", err)
	}
}
```

**Note:** Queue name is just a logical seperation and CreateQueue does a check if queue exsists if it does'nt it creates it.

### Use cases:
- **Durable delayed execution**: Persist tasks on disk and execute them exactly when their timestamp expires, even after crashes, like notifying users at a particular timestamp.

- **Self-rescheduling workflows**:  Easily build recurring or adaptive jobs by reinserting tasks with adjusted future timestamps.

- **Unified queue model**: Support FIFO, priority, and delay queues using a single time-ordered storage design.

## Future Scope
Cue currently supports single node setup, now this can be extended multi-node distributed environment with a consensus algorithm like raft in future. Cue needs to be load and stress tested to find the average deviation from the target time under load, though purpose of Cue is'nt for high throughput system.

**Github Link**: https://github.com/ayushmd/cue

## References
1. LSM Tree: https://www.cs.umb.edu/~poneil/lsmtree.pdf
2. RocksDB: https://research.facebook.com/publications/rocksdb-evolution-of-development-priorities-in-a-key-value-store-serving-large-scale-applications/
3. PebbleDB: https://www.cockroachlabs.com/blog/pebble-rocksdb-kv-store/