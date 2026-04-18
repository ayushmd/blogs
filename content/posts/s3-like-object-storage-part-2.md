---
title: "Building S3 Like Multi-Node Object Storage from scratch"
subtitle: "Part 2 - Making a multi-node s3 compatible object storage with raft consensus"
description: ""
---

### Preface

With the deprecation of Minio it peaked my interest of how a object storage something like minio & s3 would even work and provide reliability so strong that it became gold standard of so many tools and products. Well the S3 client is open source but not the actual backend so we will take a look at how the other storage layer's are designed like minio, hdfs, gfs(google file system), Ceph and create a service which functions like them. Also we aim to create a multi-node object storage so that it can be distributed across nodes.

The 3 main aim of this project: 
1. Exploring other object storages like minio, hdfs, gfs(google file system)
2. Making a multi-node object storage with consensus algorithm like raft
3. Making a s3 compliant interface and integrating a ui like minio with our backend

<details>
  <summary><strong>Series Roadmap</strong></summary>

  - [Part 1: Exploring the storage landscape HDFS, GFS, Minio & Ceph](/s3-like-object-storage-part-1)
  - **Part 2**: Making a multi-node s3 compatible object storage with raft consensus

</details>

In previous article we took a look at how other object storage work, in this part we will be building the storage layer, a multi-node raft consensus cluster with raft, supporting crud from the already existing s3 client and finally putting up a ui for easy accessibility. If you have'nt read the previous article i would recommend to go through it [here](/s3-like-object-storage-part-1).

Let's start by addressing the elephant in the room, how do we make it such that multiple node's coordinate with each other & dont miss a beat. This is generally done by a consensus algorithm like Paxos, Zookeper's ZAB, Raft.

In Distributed Systems a algorithm which is used extensively is Raft. What is it ? Why is it so popular ? What can we use to create it for ?

Well many tools and products exsists which already use raft for co-ordination

**Kubernetes & etcd:** etcd the key component of k8s which manages the state of the cluster is a key value pair distributed storage using raft.

**Kafka:** kafka recently migrated from zookeper to self implementation of raft for distributed multinode queueing.

**Nomad:** Container orchestrator which uses raft for leader election.

**CockroachDB**, **NATS** are just to name a few.

I have went through the paper, you can have a read of it at(https://raft.github.io/raft.pdf), here we will be walking through how Raft works and why we use it while implementing the specifics of our object storage so it makes sense all the way.


The Raft paper explains in great detail how the consensus algo works, the 2 key aspects of it are 
- **Leader Election**
- **Log Replication**


To create a object storage the components required would be Nodes - which will actually store the binary or blob data, A metadata store of sort which will keep track of where the data is stored, service discovery to check the available nodes and check its liveliness and also a failover mechanism in case a node goes down.


Lets start by a single master which greatly reduces the complexity in a cluster architecture. The master will be responsible for keeping track of connected nodes acting as service discovery. It will also take actions like generating plan to store the data, replicating data.


With the requirements sorted out lets take a look at how we can go around implementing it.


### Setting up Cluster

There are ways we can bootstrap a cluster, a way where we specify all the nodes at the start and the election decides who will become leader. 

The leader election in Raft happens by a node which starts as follower state if it does not recieve any leader hearbeats it converts itself to a candidate and starts a election with other nodes. 

The node with the majority votes in a term becomes the leader. If 4 nodes start together there is a randomized timeout between 150ms-300ms to prevent split votes and multiple leaders at once.

![alt text](/blogs/images/s3-like-object-storage/raft_leader.gif)

In our implementation instead of predefined nodes we will add nodes dynamically. We first start with a single node which converts itself to a leader after some terms. Then we add more nodes dynamically with the master's IP, similar to how kubernetes cluster is bootstrapped.

The node waits till it gets converted to leader once it is converted the master starts collecting metrics from all the available nodes in the cluster after certain interval everytime. Below is logic which makes sure even if the master changes it starts gathering metrics.

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


### File inserts

If we take a look at how the already exsisting file systems like hadoop and google file system there is a common pattern with file data storage. The file is divided into chunks of fixed size and these chunks are distibuted across the nodes.

Here first when the file arrives we generate a Plan based on size of the file. Let's say the file is of size `512MB`  then it will be divided into `4` equal parts of Block Size `128MB`. Now this block will be replicated across nodes, here if we choose the Replication factor of `2` the block will be stored twice in different nodes so in case if a node goes down the file can still be retrived from other nodes. In other implementaion's the Replication factor can vary from 3-5 depending on requirement. If a file of size 512MB is to be stored with Replication factor of 2 it will occupy total of 1024MB in cluster without compression.

To keep it simple we dump file parts in round robin manner so no 2 blocks with same data end up on the same node. Which can be further extended to be weighted round robin or perhaps graph based algorithm which takes descision based on parameters like available disk size, type of disks, metrics, geolocation AZ etc.

```go
func (fs *FileStore) FilePlan(fileSize int) Blueprint {
	var plan Blueprint
	var blockstore [][ReplicationFactor]Block
	var nodes []WeightedBlock

	snapshot := fs.metrics // Take snapshot of the current cluster metrics 

	for k, v := range snapshot {
		if v.DiskPercent != 0 && v.MemTotal != 0 {
			nodes = append(nodes, WeightedBlock{
				id:     k,
				addr:   k,
				weight: 0,
			})
		}
	}

	fmt.Println("Metric snap: ", snapshot) 

	numNodes := len(nodes)
	if numNodes == 0 {
		numNodes = 1
	}

	factor := ReplicationFactor
	if numNodes < ReplicationFactor { 
		// check if the number of nodes are less then Replication factor if it is keep minimum as number of nodes
		factor = numNodes
	}
	plan.NumBlocks = ceil(fileSize, BlockSize)
	plan.TotalBlocks = plan.NumBlocks * factor
	point := 0
	for i := 0; i < plan.NumBlocks; i++ {
		var singleblock [ReplicationFactor]Block
		for k := 0; k < factor; k++ {
			currNode := nodes[(point+k)%numNodes]
			singleblock[k] = Block{
				Id:   currNode.id,
				Addr: currNode.addr,
			}
		}
		blockstore = append(blockstore, singleblock)
		point = (point + 1) % numNodes
	}
	plan.Store = blockstore
	return plan
}
```

The File plan decided only by the master node as it has the metrics and hurestics to make decisions also write access to replicated log(which we will discuss in a bit).

Once the file plan generation is done the file is to be divided in chunks and replicated across desired nodes. The chunk has been further divided into windows of 16MB. As file arrives it is filled in Buffer, which is waited till its fully filled with window size (`16MB`) unless EOF occurs and a api request is fired to the node with the path. The window breakdown is done to push windows parallely via different requests.

The node's communication is done on simple HTTP 1.0 as of now, this can be optimized further with GRPC protobuf or HTTP 2 or 3.

The file is stored in chunks and windows with numbers in increasing order making it easier while reading.

Below a file name logs.txt of size (`129MB`) is stored as 
```
storage
|
|-- <bucket_name> (folder)
         |
		 |-- logs.txt (129MB) (folder)
		 		  |
		 		  |-- 0  (128MB)
				  |   |-- 0 (16MB)
				  |	  |-- 1 (16MB)
				  |	  :
				  |	  :
				  |	  :
				  |	  |-- 7 (16MB)
				  |
				  |
				  |-- 1 (1MB) (folder)
				      |-- 0 (1MB) (file)
```



Once the Insert is done the Log replication comes into play. Lets first discuss what is log replication and it happens in raft. 

Now log which might have come to your mind could be print statement logs, well its not exactly that but log here or in distributed systems refers to entry of action. When some change is to be done to the state it is captured as a 'log', a log has a index, term in which it was sent out, and the action (whatevery we want to be replicated across node). Now the replicating log can be anything it can be query or perhaps a metadata language used for internal communication

if we were to create a distributed kv-store we would replicate all the set queries via raft log, something like 

| Index | Term | Command  |
|-------|------|----------|
|1      | 1    | SET x=10 |
|2      | 1    | SET y=20 |
|3      | 2    | SET x=15 |

In raft we can also snapshot or go through the sequence of logs to reach to the same state again. We are using Hashicorp Raft Implementation.

Here we are replicating good old json, which has `type` tag which tells us what type of operation it is `create` or `delete`. We are esentially replicating the plan or metadata across node's and storing them on all nodes.


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

	// allows MaxWorker(int), the number of parallel requests
	workers := make(chan struct{}, MaxWorker) 
	buf := make([]byte, WindowSize)
	errCh := make(chan error, ErrChSize)

	totalRead := 0
	path := filepath.Join(bucket, key)

	for {
		n, err := io.ReadFull(r, buf)
		if n > 0 {
			var currBlock int = totalRead / BlockSize
			var currWindow int = (totalRead % BlockSize) / WindowSize
			block := plan.Store[currBlock]
			dataCopy := make([]byte, n) // this buffer is to send the data via parallel request
			copy(dataCopy, buf[:n]) 

			for k := 0; k < ReplicationFactor; k++ {
				workers <- struct{}{}
				go func(blockNum, windowNum int, data []byte) {
					// go routine to send file chunks to different nodes

					defer func() {
						<-workers
					}()
					fmt.Println("Sending block", blockNum, "window", windowNum, "size", len(data))

					// sends file window of a chunk to appropriate address
					es := sendFilePeer(
						path,
						block[k].Addr,
						blockNum,
						windowNum,
						dataCopy,
					)
					errCh <- es
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
	if err := <-errCh; err != nil {
		return err
	}

    // metadata object which is replicated via json
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

The above is the main code block which shows how a file is stored and replicated. First it creates a plan from leader. Then the files is buffered upto window size(currently `16MB`). Then `sendFilePeer` is responsible to send file window via a single request. Finally the `SubmitOperation` does raft log application.

In raft the changes happen through Leader so the action request even sent to any node is proxied to leader(in application code). After file inserts are done the file creation log is sent to leader which updates it to all the nodes and each node stores it to its in memory map. 

You may think what if log sequence get's messed up due to failures or shutdown? 

No it does'nt that's the neat part Raft ensures the log sequence is maintained, the log is committed only if majority consensus is reached. Even if the leader fails and comes back up again it becomes follower and is brought in sync by the leader to commit to the log sequence and deleting conflicting logs. Not to say there are no other issues but raft handles the log sequence.


### File Fetching

When we recieve a `get` file request it can be sent to any of the node as plan replication is done to all the nodes. We get metadata mapping from the reciever node. The leased node then assimilates chunks from the different adrresses where it is stored. 

```go
func (fs *FileStore) GetEntireFile(bucket, key string) (readerWithClosers, error) {
	metadata := fs.meta[path] // In mem memory metadata mapper

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

### So is it DONE?

well not really

Currently these are the main function which does the fetching and creation of files but it has stark issue, which is the system is not race safe as a whole. If the same api is called at 2 nodes it races to upload a file to same path which will cause collision and corruption. There are 2 ways we can solve this issue.
1) **Doing atomic inserts:** The co-ordination is done by global or distributed locks over a bucket and key path.
2) **Doing multiple inserts:** The system is constructed with view of eventual consistency and multiple files are uploaded for same key path.

The first way ensures efficient resource utilisation but is difficult to manage at scale and managing locks is another overhead. The second option is where the files are assigned identifier and a mapping is maintained between the id and path key. If 2 files race to upload at same path, the last upload should win. This way we can ensure s3 like behaviour and avoids collisions.

We will need a storage layer to store the metadata and mappings for quick lookups and which will ensure persistence. Lets bring in pebble db a trusted kv storage engine from previous [article](/time-based-cue).

We run embedded db on each node along with our server only, pebbledb is a embedded db so it does'nt need to be deployed like a server. we spin up db which gives you access to db operations similar to sqlite. The state maintained in db is same throughout as Raft ensures seqence as we saw earlier, so all the db instances across node's are in sync. This is similar to etcd, where it uses badger and raft for distributed kv store but we only store a metadata not a generalized storage like etcd.

Pebble db does not support atomic operations inherently. But we kind of dont need to do atomic updates, just like we did for the file storage we store multiple entries, and do the update for the last one approaching and cleanup the rest of entries. 
So now we have a storage layer which acts like switch to many clients who race to do file uploads but the db points to the last entry only.

The files are stored in structure as 
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

so if concurrent write happens at `logs.txt` the file will be corrupted, so provide each file upload a identifier or a uuid and store multiple copies and the last upload to complete will be where the metadata db be pointing to, much like dns.

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

This is a tradeoff again, more storage for reliability and durability. This also opens up a window for another feature which is versioning, we can mark id's as version's then keep and cleanup data as per versioning policies, though we wont be implementing it currently.


<!-- Let's now discuss how the data is stored in our key-value database, you might ask why not a full db is used, which has multiple column's or a document perhaps? why kv db?. But I'd say we dont need a db as such, at storage layer a lot of db's end up looking like a ordered key-value pairs even when you store it in multi-column format, so if we are not looking for any complex joins or backups or transactions but only direct queries embedded db work just fine. A embedded db like rock's db or pebble db is used by other db and tools, the heavy lifiting is already done by this embedded db layer, the data is indexed, and you get to store exactly what you want. Embedded db also give you full control on how you want to store and how much you want to store.  -->

<!-- The main selling feature rather is it get's bundled in one single binary no external dependencies. -->

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


Currently all the nodes support all the api's instead of just master, how? for get requests it uses the distributed kv layer that we have created with raft and for decision based api's like file plan and raft operations the current node check's if it is the master, yes then it does the operation else it make's api call to leader so each node act's like a proxy. 

Which means we can load balance via any L4 L7 Load balancer like haproxy or nginx and everything should work just fine from all the nodes. This behaviour is similar to Minio.

### Making our backend usable

The S3 compatible api is pretty much straight forward, S3 follows simple nomenclature the operations are performed according to api request path. CRUD is done on path `/{bucket}/{path}`, currently we only support 3-4 main functions. To create a complete support for all s3 api's is a task of it's own. Below is list of supported api's.

```
r.HandleFunc("/", fs.ListBucketsS3).Methods("GET")
r.HandleFunc("/{bucket}", fs.CreateBucketS3).Methods("PUT")
r.HandleFunc("/{bucket}", fs.HeadBucketS3).Methods("HEAD")
r.HandleFunc("/{bucket}", fs.ListObjectsV2S3).Methods("GET")
r.HandleFunc("/{bucket}/", fs.ListObjectsV2S3).Methods("GET")
r.HandleFunc("/{bucket}/{filepath:.+}", fs.GetS3File).Methods("GET")
r.HandleFunc("/{bucket}/{filepath:.+}", fs.HeadS3File).Methods("HEAD")
r.HandleFunc("/{bucket}/{filepath:.+}", fs.PutS3File).Methods("PUT")
r.HandleFunc("/{bucket}/", fs.PutS3File).Methods("PUT")
r.HandleFunc("/{bucket}/{filepath:.+}", fs.DeleteS3File).Methods("DELETE")
```

With support of these api's we can use s3 sdk in any language and it should work for these operation. The official s3 api documentation helped a lot in implementing the api's, also s3 api's widely use xml and that's that.

It would be a bit convinent to have a ui, so instead of creating a ui of own i thought why not fork the minio ui. Minio UI called `object-browser`  ~is~  was open source under AGPL when i had forked it but seems to have been taken down ever since, also pulled from my github fork's 🤔. Turn's out the ui has been stripped from past year and finally taken down, anyways we only want a barebone ui to do our operations.

The ui is not just frontend, the frontend has a go backend which does all the api requests and renders it to the frontend. So the main logic we need to change is a go backend. The object-browser had lot's of moving parts web sockets, authentication, prefetches and what not.

# JUST GIVE ME THE UI

So after wrangling my head around a bit i was able to bypass and remove authentication, yet it did'nt seem to work as i wanted it to. Only listing api was working. This was the perfect use case for AI, with the help of Cursor i was able to make it work with my backend and finally we have a UI.

<show_ui_demo>

Also now as we support the S3 API's we have access to wide list of libraries and sdk's across languages. So wrote a simple script which goes throught the files check if it is a csv if it is it downloads and merges all the csv's to one. 

```py
paginator = s3.get_paginator("list_objects_v2")
first = True
for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
    for obj in page.get("Contents", []):
        key = obj["Key"]

        if key.lower().endswith(".csv"):
            print(f"Processing {key}")

            response = s3.get_object(Bucket=BUCKET, Key=key)
            df = pd.read_csv(BytesIO(response["Body"].read()))

            df.to_csv(
                OUTPUT_FILE,
                mode="w" if first else "a",
                header=first,
                index=False
            )
            first = False
print(f"Saved merged file to {OUTPUT_FILE}")
```

and voila it works like a charm

After making this my wish extended to also support spark application's as well. But it requires me to implement a lot more function's

`CopyObjectS3`, `DeleteObjectsS3`, `GetBucketLocationS3`, `CreateMultipartUploadS3`, `UploadPartS3`, `CompleteMultipartUploadS3`, `AbortMultipartUploadS3`, `ListPartsS3`, `ListMultipartUploadsS3`, `GetRangedObject`

Esentially optimised functions for the exsisting CRUD operations. Though we can incorporate these functions with minor changes in the exsisting architecture, but we have achieved what we started with, so might implement these feature's some time in future.

Though the above section of UI and S3 Client API's might sound short compared to article but took the most time in figuring out and playing around 😅.

## References
- https://raft.github.io/raft.pdf
- https://github.com/hashicorp/raft
- https://docs.aws.amazon.com/AmazonS3/latest/API/Type_API_Reference.html