---
title: "Building S3 Like Multi-Node Object Storage from scratch"
subtitle: "Part 2 - Making a multi-node s3 compatible object storage with raft consensus"
description: ""
---


In Distributed Systems a algorithm which is used extensively comes up which is Raft. What is it ? Why is it so popular ? What can we use to create it for ?
Well many tools and products exsists which already use raft as a consensus algorithm in distributed setting

etcd: key component of k8s which manages the state of the cluster is a key value pair distributed storage using raft

kafka: kafka recently migrated from zookeper to self implementation of raft for distributed multinode queueing

Nomad: Container orchestrator which uses raft for leader election.

CockroachDB, MinIO, NATS are just to name a few.

### Raft Paper (https://raft.github.io/raft.pdf)
The raft paper explains in great detail how the consensus algo works the 2 key aspects of raft are 
1. Leader Election
2. Log Replication

Lets go in detail with the aspect based on the implementation of object storage

To create a object storage the components required would be  Nodes - which will actually store the binary or blob data, A metadata store of sort which will keep track of where the data is stored, service discovery to check the available nodes and check its liveliness and also a failover mechanism in case a node goes down.

In this implementation we will use raft for all the above requirements. Lets start by a single master which greatly reduces the complexity in a cluster architecture. The master will be responsible for keeping track of connected nodes acting as service discovery. It will also take actions like generating plan to store the data, replicating data.

<!-- Raft will also provide a way with HA and ensure the metadata is replicated, we will do replication of same file data. -->

With the requirements sorted out lets take a look at how we can go around implementing it.

### Setting up Cluster

There are ways we can bootstrap a cluster, a way where we specify all the nodes at the start and the election decides who will become leader. 

The leader election in Raft happens by a node which starts as follower state if it does not recieve any leader hearbeats it converts itself to a candidate and starts a election with other nodes. 

The node with the majority votes in a term becomes the leader. If 4 nodes start together there is a randomized timeout between 150ms-300ms to prevent split votes and multiple leaders at once.

In this approach instead of predefined nodes we will add nodes dynamically. We first start with a single node which converts itself to a leader after some terms. Then we add more nodes dynamically with the master's IP, similar to how kubernetes cluster is bootstrapped.

The node waits till it gets converted to leader once it is converted the master starts collecting metrics from all the available nodes in the cluster. This makes sure even if the master changes it starts gathering metrics.

```go
func (fs *FileStore) GatherMetrics() {
	leaderCh := fs.raft.LeaderCh()
lead:
	for {
		select {
		case isLeader := <-leaderCh:
			if isLeader {
				break lead
			}
		}
	}
	ticker := time.NewTicker(MetricsInterval * time.Second)
	for {
		select {
		case <-ticker.C:
			f := fs.raft.GetConfiguration()
			if err := f.Error(); err != nil {
				log.Printf("failed to get raft configuration: %v", err)
				return
			}
			for _, srv := range f.Configuration().Servers {
				log.Printf("Node ID: %s, Address: %s, Suffrage: %s",
					srv.ID, srv.Address, srv.Suffrage)
				mdata, err := getMetrics(string(srv.ID))
				if err == nil {
					fmt.Println(mdata)
					fs.metrics[string(srv.ID)] = mdata
				} else {
					fs.metrics[string(srv.ID)] = Metrics{
						Addr:        string(srv.ID),
						CpuPercent:  0,
						MemTotal:    0,
						MemUsed:     0,
						MemPercent:  0,
						DiskTotal:   0,
						DiskUsed:    0,
						DiskPercent: 0,
					}
				}
				// fmt.Println("Metrics:", fs.metrics, len(fs.metrics))
			}
		case isLeader := <-leaderCh:
			if !isLeader {
				goto lead
			}
		}
	}
}
```

Thats why the elected master is responsible for all the decisions of the cluster as it holds the infromation of all the nodes liveliness.

### File inserts

If we take a look at how the already exsisting file systems like hadoop and google file system there is a common pattern with file data storage. The file is divided into chunks of fixed size and these chunks are distibuted across the nodes.

Here first when the file arrives we generate a Plan based on size of the file. Let's say the file is of size 512MB  then it will be divided into 4 equal parts of Block Size 128MB. Now this blocks will be replicated accross nodes, here if we choose the Replication factor of 2 the blocks will be stored twice in different nodes so in case if a node goes down the file can still be retrived from other nodes. In other implementaion the Replication factor can vary from 3-5 depending on requirement availability. If a file of size 512MB is to be stored with Replication factor of 2 it will occupy total of 1024MB in cluster without compression.

So let's keep it simple and dump file parts in round robin manner so no 2 blocks with same data end up on same node. Which can be further extended to be weighted round robin or perhaps graph based algorithms which takes descision based on parameters like available disk size, type of disks, metrics, network location etc.

The File plan decided only by the master node as it has the metrics and hurestics to make decisions also write access to replicated log.

Once the file plan generation is done the file is to be divided in chunks and sent. The chunk has been further divided into windows of 16MB. A Buffer is waited till its fully filled with 16MB unsless EOF occurs and a api request is fired to the node with the plan. This is done to push windows parallely via different requests. <code_block>  

The file is stored in chunks and windows with numbers in increasing order making it easier while reading.
<show_entire_simulation>

Once the Insert is done the Log replication comes into play. Lets first discuss how log replication happens in raft. <explain_log_replication_raft_detailed>

In raft the changes happend through the Leader so the action request even sent to any node is proxied to leader. After file inserts are done the file creation log is sent to leader which updates it to all the nodes. 
These logs are used to replicate metadata to all the nodes in cluster. The fileplan here is sent to all the nodes.

Lets say when a get request arrives it can be sent to any of the node as plan replication is done to all the nodes. 

```go
func (fs *FileStore) CreateFile(bucket, key, compression string, size int, r io.Reader) error {
	var plan Blueprint
	var err error

	// Get blueprint or the plan which tells where will a block go
	if fs.IsLeader() { // determines if current node is leader
		plan = fs.FilePlan(size)
	} else {
		// api call and get plan from leader
		_, haddr := fs.GetLeader()
		plan, err = getPlan(haddr, size)
		if err != nil {
			fmt.Println("Error getting plan from leader:", err)
			return err
		}
	}

	fmt.Println("Plan:", plan)

	workers := make(chan struct{}, MaxWorker)
	buf := make([]byte, WindowSize)

	totalRead := 0
	path := filepath.Join(bucket, key)

	for {
		n, err := io.ReadFull(r, buf)
		// n, err := r.Read(buf)
		if n > 0 {
			var currBlock int = totalRead / BlockSize
			var currWindow int = (totalRead % BlockSize) / WindowSize
			block := plan.Store[currBlock]
			dataCopy := make([]byte, n)
			copy(dataCopy, buf[:n])
			for k := 0; k < ReplicationFactor; k++ {
				workers <- struct{}{}
				go func(blockNum, windowNum int, data []byte) {
					defer func() {
						<-workers
					}()
					fmt.Println("Sending block", blockNum, "window", windowNum, "size", len(data))
					sendFilePeer(
						path,
						block[k].Addr,
						blockNum,
						windowNum,
						dataCopy,
					)
				}(currBlock, currWindow, dataCopy)
			}
			totalRead += n
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
	}

	var op FileOperation = FileOperation{
		Type: "create",
		FileMetadata: FileMetadata{
			Bucket:      bucket,
			Key:         key,
			Compression: compression,
			Size:        size,
			Timestamp:   time.Now().Unix(),
			Blueprint:   plan,
		},
	}
	fmt.Println("Sent blocks: ", op)
	if fs.IsLeader() {
		fs.SubmitOperation(op)
	} else {
		_, lid := fs.GetLeader()
		err := setOperation(lid, op)
		fmt.Println("Operation sending to leader: ", lid, err)
	}
	fmt.Println("Operation submitted")
	return nil
}
```

Currently this is the main function which does the creation of file but it has stark issue, which is it is not race safe as a whole. if the same api is called at 2 nodes it races to upload a file to same set of possible path which will cause collision and corruption. So we need to co-ordinate amongst node to avoid collision. There are 2 ways to look at this issue
1) Doing atomic inserts: The co-ordination is done by global or distributed locks over a bucket and key path
2) Doing multiple inserts: The system is constructed with view of eventual consistency and multiple files are uploaded for same key path.

The first way ensures efficient resource utilisation but is difficult to manage at scale and managing locks is another overhead. The second option is where the files are assigned identifier and a mapping is maintained between the id and key. If 2 files race to upload at same path, the last upload wins and older versions are eventually cleaned. This way ensures s3 like behaviour and avoids collisions.

We will need a storage layer to store the metadata and mappings for quick lookups. Lets bring in pebble db a trusted storage engine from previous article. <explain_storage_methods>

Pebble db does not support atomic operations inherently. So we can make it so that it is appears atomic and safe for multi concurrent reads and writes on a single location. 

The current storage is stored is structured as 
```
storage
|
|-- <bucket_name>
         |
		 |-- logs.txt (448MB)
		 |		  |-- 0  (128MB)
		 |		  |-- 1  (128MB)
		 |		  |-- 2  (128MB)
		 |		  |-- 3  (64MB)
         |
         |-- love_letter.pdf (129MB)
				  |-- 0  (128MB)
				  |-- 1  (1MB)
```

so if concurrent writes happen in this location the file will be corrupted, so what we do is we provide each file upload a identifier or a uuid and store multiple copies and the last upload to complete the upload will be where the metadata db be pointing to, much like dns, where dns pointing changes the ip the traffic is routed to updated ip, though dns is a eventually available storage due to ttl, a db rather is a point in time replacement. so once db points to the updated file we can cleanup the old file eventually, so now the storage looks like

```
storage
|
|-- <bucket_name>
         |
		 |-- logs.txt (448MB)
		 |        |
		 |		  |-- d584e2b7-459b-4a9c-a7b7-44bef101ff07
		 |		  |					|-- 1  (128MB)
		 |		  |					|-- 2  (128MB)
		 |		  |					|-- 3  (64MB)
		 |		  |
		 |		  |-- 057d7ca0-73da-4484-90bf-9c8cb3258668 (marked for cleanup)
		 |							|-- 1  (128MB)
		 |							|-- 2  (128MB)
		 |							|-- 3  (64MB)		
         |
         |-- love_letter.pdf (129MB)
		          |
				  |-- ebad6e16-e17a-4079-b97e-058c994afc79
				  					|-- 0  (128MB)
									|-- 1  (1MB)
```

This is a tradeoff again, more storage for reliability and durability. This also opens up a window for another feature which is versioning, we can mark id's as version then keep and cleanup data as per versioning policies, though we wont be implementing it in the currently.

So during get operation the db points to the latest file. 

```go
func (fs *FileStore) GetEntireFile(bucket, key string) (readerWithClosers, error) {
	// metadata := fs.meta[path] // earlier in mem memory metadata mapper

	meta, ek := fs.store.GetKey(bucket, path) // get metadata stored during put from db
	if ek != nil {
		return readerWithClosers{}, ek
	}

	path := filepath.Join(meta.Bucket, meta.Key, meta.Identifier)

	NumBlocks := meta.NumBlocks
	readers := make([]io.Reader, NumBlocks)
	closers := make([]func() error, NumBlocks)
	errCh := make(chan error, NumBlocks)
	var wg sync.WaitGroup

	for i := 0; i < NumBlocks; i++ {
		wg.Add(1)
		go func(block int) { // fetch all blocks parallely and assemble them in desired sequence
			defer wg.Done()
			client := &http.Client{}

			var r io.Reader
			var closeFunc func() error
			var err error

			// Try all replicas
			for j := 0; j < ReplicationFactor; j++ {
				addr := meta.Store[block][j].Addr // address of node where file is
				// stream file from peer
				r, closeFunc, err = getFilePeer(path, addr, block, client)
				if err == nil {
					readers[block] = r
					closers[block] = closeFunc
					return
				} else {
					fmt.Println("Error getFilePeer", block, "from", addr, ":", err)
				}
			}

			// All replicas failed
			errCh <- fmt.Errorf("failed to fetch block %d: %w", block, err)
		}(i)
	}

	wg.Wait()
	close(errCh)

	// Check for errors
	if len(errCh) > 0 {
		// Close any open readers before returning
		for _, c := range closers {
			if c != nil {
				_ = c()
			}
		}
		return readerWithClosers{}, <-errCh
	}

	// Combine all block readers
	multiReader := io.MultiReader(readers...)

	// Wrap to ensure closers are called after reading
	return readerWithClosers{
		Reader:  multiReader,
		closers: closers,
	}, nil
}
```

In the above code snippet you can see the file is fetched from peer's in the sequence of how they are stored from replicas, if one replica fails it tries other. These are reader's exposed by the api request so not all the data is loaded in memory but the reader's are combined to give a single reader, so while pipeing it back to the client our server is not overloaded in memory and can do the congestion control (send only as much as client can handle).

Let's now discuss how the data is stored in our key-value database, you might ask why not a full db is used, which has multiple column's or a document perhaps? why kv db?. But I'd say we dont need a db as such, at storage layer a lot of db's end up looking like a ordered key-value pairs even when you store it in multi-column format, so if we are not looking for any complex joins or backups or transactions but only direct queries embedded db work just fine. A embedded db like rock's db or pebble db is used by other db and tools, the heavy lifiting is already done by this embedded db layer, the data is indexed, and you get to store exactly what you want. Embedded db also give you full control on how you want to store and how much you want to store. 

The main selling feature rather is it get's bundled in one single binary no external dependencies.

As we are using raft already our db is a distributed key-value db, a record change made on one is reflected everywhere and raft ensures the sequence of queries are same everywhere.

```go
func (fs *FileStore) Apply(log *raft.Log) interface{} {
	var op FileOperation
	if err := json.Unmarshal(log.Data, &op); err != nil {
		fmt.Printf("Failed to unmarshal log entry: %v", err)
		return nil
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	path := filepath.Join(op.Bucket, op.Key)
	fmt.Println("Applying operation:", op.Type, "=", op)
	switch op.Type {
	case "create": // for create file or put file
		// fs.meta[path] = op.FileMetadata

		er := fs.store.UpsertKeyAsync(op.FileMetadata) 
		// this async is async disk write not to be mistaken for async db writes.
		if er != nil {
			fmt.Println("Error: ", er)
		}
		er = fs.store.InsertIdentifierAsync(op.FileMetadata)
		if er != nil {
			fmt.Println("Error: ", er)
		}
		deletes, er := fs.store.DeleteOldIdentifiers(op.FileMetadata)
		if er != nil {
			fmt.Println("Error: ", er)
		}
		for _, d := range deletes {
			delpath := filepath.Join(d.Bucket, d.Key, d.Identifier)
			uniqueEndpoints := make(map[string]struct{}) // acts as a set
			for _, v := range d.Store {
				for _, block := range v {
					uniqueEndpoints[block.Addr] = struct{}{}
				}
			}
			for url, _ := range uniqueEndpoints {
				// deletes from local if the url matches with it's own
				go deleteFile(url, delpath) 
			}
		}
		return nil
	case "delete":
		// delete(fs.meta, path)

		err := fs.store.DeleteKey(op.Bucket, op.Key)
		if err != nil {
			fmt.Println("Error: ", err)
		}
		return nil
	default:
		fmt.Printf("Unknown operation type: %s", op.Type)
		return nil
	}
}
```


Currently all the nodes support all the api's instead of just master, how? for get requests it uses the distributed kv layer that we have created with raft and for deciding api like deciding file plan and doing submit operation's on raft master the current node check's if it is the master it does the operation else it make's api call to leader so each node act's like a proxy. 

Which means we can load balance via any L4 L7 Load balancer like haproxy or nginx and everything should work just fine from all the nodes. This behaviour is similar to Minio.
