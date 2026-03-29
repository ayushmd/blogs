---
title: "Building S3 Like Multi-Node Object Storage from scratch: Exploring the Storage landsacpe"
subtitle: "Part 1 - Exploring the storage landscape HDFS, GFS, Minio & Ceph."
date: "2026-03-29"
description: "This article is a extract of research paper's of hdfs, gfs, ceph and also explores how other solutions work including Minio, S3 and Kubernetes native CSI Storages."
tags: ["go", "s3", "distributed", "raft", "from scratch", "system design", "hdfs", "gfs", "minio", "ceph", "kubernetes", "csi", "longhorn", "rook", "white paper"]
---

![alt text](/blogs/images/s3-like-object-storage/part-1-cover-photo.png)

### Preface

With the deprecation of Minio it peaked my interest of how a object storage something like minio & s3 would even work and provide reliability so strong that it became gold standard of so many tools and products. Well the S3 client is open source but not the actual backend so we will take a look at how the other storage layer's are designed like minio, hdfs, gfs(google file system), Ceph and create a service which functions like them. Also we aim to create a multi-node object storage so that it can be distributed across nodes.

The 3 main aim of this project: 
1. Exploring other object storages like minio, hdfs, gfs(google file system)
2. Making a multi-node object storage with consensus algorithm like raft
3. Making a s3 compliant interace and integrating a ui like minio with our backend

<details>
  <summary><strong>Series Roadmap</strong></summary>

  - **Part 1:** Exploring the storage landscape HDFS, GFS, Minio & Ceph.
  - [Part 2: Making a multi-node s3 compatible object storage with raft consensus](/s3-like-object-storage-part-2)

</details>

## Storage Services

I went through the white paper of HDFS, GFS, Ceph and docs of Minio to learn about how these tools are built and below is extract of each of them. Link of each of the paper is in references at the very end.

## HDFS (Hadoop Distributed File System)

The classic	storage service which has been followed afterwards by many tools. HDFS from Hadoop ecosystem is a storage service for storing large amounts of data, with the hadoop ecosystem it allows partitioning of data and computation across many (thousands) of hosts, and executing application computations in parallel close to the data.

HDFS Architecture consists of 2 main components NameNode and DataNode.

- **NameNode** - Name node is a node that stores the metadata not the actual data it is the master which decides where data is stored. 
- **DataNode** - Data node is the node where the data is actually stored.

There are more nodes which can be configured such as CheckpointNode or BackupNode for snapshots and backups.

HDFS partitions a data files in number of blocks each of size usually `128MB`. These Blocks are replciated across nodes based on replication factor usually `3`, which means a file of size `1GB` takes up `3GB` in total. 

In HDFS the client communicates the namenode for locating where data is stored and then the client itslef gathers the data from the data nodes. This is the architecture difference between something like s3 and hdfs, s3 doesnt give the location of where the actual data is stored rather the s3 api only assimalates the data and pipe's it to the client.

![alt text](/blogs/images/s3-like-object-storage/hdfs_architecture.jpg)

### HA in HDFS

HA in hdfs is managed by zookeper which make sures only a single master is running and promotes the standby master whe the actual master goes down. Zookeper is also responsible for metadata and configuration management across multiple nodes. ZK also provides with distributed lock's and distributed queues.


## GFS (Google File System)

Google File System (GFS) according the official paper is a scalable distributed file system for large distributed data-intensive applications. It provides fault tolerance while running on inexpensive commodity hardware, and it delivers high aggregate performance to a large number of clients.

Like HDFS, GFS splits responsibilities between metadata and actual data storage, but the paper is interesting because many patterns from modern storage systems can be traced back to it.

Architecture of GFS has 2 primary components:

- **Master** - The master stores metadata such as namespace, file to chunk mappings, chunk version numbers, leases, and replica locations. It decides placement and recovery actions but does not sit in the hot path for data transfer.
- **ChunkServers** - Chunkservers store the actual chunk data on local disks, serve reads and writes to clients, and periodically report state to the master.

The file itself is split into **chunks** of `64MB`, much larger than traditional file systems. Each chunk gets a globally unique handle and is replicated, usually `3` times, across multiple chunkservers.

**How reads and writes work:** When a client wants to read, it first asks the master which chunk contains the requested offset and where replicas live. The master returns the chunk handle and replica locations, then the client talks directly to the chunkserver very similar to HDFS. For writes, the master grants a **lease** to one replica making it the **primary** for that chunk. The client pushes data to all replicas, but the primary decides the final ordering of mutations and tells secondaries to apply them in the same order. This keeps replicas consistent while avoiding sending every byte through the master.

One of the most well-known GFS features is **record append**. Instead of only supporting overwrite-style writes, GFS was designed for large distributed producers appending records to shared files, like logs or crawled data. The system accepts that duplicate records can happen in failures or retries, and applications are expected to tolerate that. Also in case of atomic append chunk writes, if the size exceeds the chunk size limit, the primary checks to see if appending the record to the current chunk would cause the chunk to exceed the maximum size (64 MB). If so, it pads the chunk to the maximum size, tells secondaries to do the same, and replies to the client indicating that the operation should be retried on the next chunk. 

![alt text](/blogs/images/s3-like-object-storage/gfs_architecture.png)

### HA in GFS

GFS is a single master cluster, the metadata is replicated accross nodes via Operation log very similar to what we are going to do. It does checkpointing and heartbeats as well, all the standard features in distributed systems. GFS does'nt do andy cluster consensus it follows the model of one brain with backups instead of multiple brains constantly agreeing.



## Minio 

"'
*MinIO is a high-performance, S3-compatible object storage solution released under the GNU AGPL v3.0 license. 
Designed for speed and scalability, it powers AI/ML, analytics, and data-intensive workloads with industry-leading performance.*
'"

This is how minio describe's itself, minio shines in baremetal environment where it also provides s3 compatibility. Though it is open source but has been declared deperecated recently and other soultions have emerged since which have forked from the original repo. But we are here to discuss how is minio designed. Minio is bit seperate from how hdfs or gfs are architected. Disks are considered a single unit instead of a node like other storage service's. Minio does **Erasure Coding** instead of replication, instead of storing the entire replica of chunk it partitions the file data and stores parity based on Reed-Solomon Algorithm, the tradeoff is for reduced storage but increased CPU usage compared to storing direct replica. 

Lets take a example, if a file is of size `512MB` a hdfs or gfs with replication factor `2` will use the total storage of 

`512MB * 2 = 1024MB (1GB)` 

on the other hand in minio, with `4` disks and `2` parity, file data is divided into `4` parts i.e. 

data size: `512MB/4 = 128MB` 

parity: `2 * 128MB = 256MB`

Total Storage: `512MB + 256MB = 768MB` 

which is `25%` reduction with the same level of fault tolerance(rather better) but more cpu is required for recovery. This scales better compared to replication factor in many cases. Minio scales better across multiple disks.

![alt text](/blogs/images/s3-like-object-storage/minio_architecture.jpg)

### HA in Minio

There are multiple ways of minio HA. There is no single master as such but it is a complete distributed network. As Minio already stores based on drives on multiple nodes the chunks are distributed based on drives only. The traffic can be forwarded to any of the nodes and it will give the same response.

Minio also has Active-Active repliation which does full duplex replication of data between sites. This method is used generally for replication between 2 Regions.

## Ceph

Ceph is one of the most complete distributed storage systems because it is not limited to one interface. It can expose **object storage** through `RADOS Gateway` (S3 / Swift compatible), **block storage** through `RBD`, and **distributed file mounts** through `CephFS` on top of the same cluster. So unlike HDFS or GFS which are primarily distributed file systems, Ceph is more like a full storage platform.

At the core of Ceph is **RADOS** (Reliable Autonomic Distributed Object Store). Everything eventually maps to objects in RADOS pools, and the higher-level interfaces sit on top of that base layer.

**Architecture.** A Ceph cluster usually has these main components:

- **MON (Monitors)** - maintain cluster membership and the authoritative cluster map. They are tiny compared to the storage nodes, but they are critical and usually run in odd numbers like `3` or `5` for quorum or the cluster managers.
- **OSD (Object Storage Daemons)** - the actual storage workers. Each OSD manages a disk or storage device, stores objects, handles replication, recovery, and rebalancing, and serves client IO.
- **MDS (Metadata Servers)** - used only for **CephFS** to manage file-system metadata and namespace. They are not required for object-only access.
- **RGW (RADOS Gateway)** - the S3-compatible API layer that makes Ceph look like an object store to external clients.

These components serve seperate purposes but can be hosted on same nodes at the same time.

The most interesting Ceph idea is that it avoids central metadata master for object placement. Instead of asking a master “where should this object live?”, Ceph uses the **CRUSH** algorithm (Controlled Replication Under Scalable Hashing). CRUSH computes placement deterministically from the cluster map, replication rules, and failure domains. So clients and OSDs can derive placement without a NameNode-like lookup for every object request.

**Replication and placement.** Data is stored in **pools**, and each pool can use either normal replication or erasure coding. With replication, Ceph may keep `3` copies of an object across different OSDs, hosts, or racks depending on the CRUSH rules. This is powerful because placement can be topology-aware from the start. Instead of just “three copies anywhere,” Ceph can explicitly avoid putting all replicas on the same host or rack. Also Ceph support **Erasure coding** similar to minio.


![alt text](/blogs/images/s3-like-object-storage/ceph_architecture.png)

### HA in Ceph

This is one of the biggest conceptual differences from HDFS or GFS. In those systems a metadata master plays a central role in deciding where data lives. In Ceph, much of that intelligence is distributed and decentralized, this avoids SPOF in the system. Ceph uses PAXOS Consensus via MON's which runs the cluster.

## S3 (Simple Storage Service) 

Though the S3 object storage backend is proprietry and closed source, there are no official details about the implemention in public domain. But articles from employees or talks gives us few insights so as to how S3 actually functions. A article here (https://www.allthingsdistributed.com/2023/07/building-and-operating-a-pretty-big-storage-system.html) suggests S3 also uses **erasure coding** for storage across disks and uses Dynamodb as a service to store metadata. Though there will be many nuances and implementation aspects to s3. 

Unlike other storage services which gives the actual ip or location of where the data is stored S3 doesnt, it pipe's the data from where the data might be stored in internal system from the single point where the connection was established, though this increases a network hop but provides node security by not exposing the node ip. 


![alt text](/blogs/images/s3-like-object-storage/s3_architecture.png)

## Honorable mentions

Now lets discuss a few mentions apart from object storage, these are not intended to act like a object storage or at least thats not the primary goal but are often used in applications, i am talking about Kubernetes CSI providers.

### Longhorn

Longhorn is a CSI driver from the rancher ecosystem which is responsible for replicating Volumes in Kubernetes cluster across nodes to provide HA and persistence. I personally like this tool as it is simple yet effective in self hosted cluster's. Longhorn being from rancher ecosystem easily integrates with RKE (Rancher Kubernetes Engine).

![alt text](/blogs/images/s3-like-object-storage/longhorn_architecture.svg)


### Rook & Ceph

Rook is kuberenetes native orchestrator which relies on Ceph as storage backend, we have explored Ceph earlier. Rook & Ceph is widely used for Bare-Metal Kubernetes volume storage.


Here most of the heavy lifting is done by kubernetes and these solutions makes sure it complies with the kubernetes CSI Spec to provide distributed storage. There are also cloud based ebs solution's for k8s and openebs which you can research about.


## Conclusion

So HDFS and GFS teach the classic **metadata + chunk replicas** model, and MinIO shows a practical modern S3-compatible implementation, Ceph shows how far you can take a storage system when placement, recovery, and interfaces are all independent building blocks.


## So finally what we will be building next?

Contrary to the sequence of articles, i had built the project first as per my understanding then went through other solutions to check how much it aligns with the industry tools, the alignment is interesting. The project has similarity as, it is has as S3 Client interaction (which is it uses sdk of s3 and object storage ui of minio which is s3 compliant), Cluster consensus similar to Ceph & Kubernetes with raft consensus, decentralized access pattern like Minio (ie each operation can be performed from any node) and mainly simple storage pattern of chunks like HDFS & GFS.

## References 
- https://pages.cs.wisc.edu/~akella/CS838/F15/838-CloudPapers/hdfs.pdf
- https://static.googleusercontent.com/media/research.google.com/en//archive/gfs-sosp2003.pdf
- https://docs.min.io/enterprise/aistor-object-store/operations/core-concepts/
- https://ceph.io/assets/pdfs/weil-ceph-osdi06.pdf
- https://vutr.substack.com/p/i-spent-8-hours-reading-the-paper-523
- https://www.allthingsdistributed.com/2023/07/building-and-operating-a-pretty-big-storage-system.html
- https://highscalability.com/behind-aws-s3s-massive-scale/