export const handler = async (event:any)=>{
    console.log("Language Fetcher Event",JSON.stringify(event,null,2));

    return{
        statusCode: 200,
        headers:{
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
            message: "Hello from Language Fetcher!",
            input: event,
        })
    }

}